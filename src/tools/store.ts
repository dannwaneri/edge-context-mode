import type {
  ContextEntry,
  EntryType,
  IndexOptions,
  SearchResult,
} from "../types.js";

// ─── nanoid-lite: no npm dep, workers-safe ────────────────────────────────────
function nanoid(len = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

// ─── Vectorize MCP Worker client ─────────────────────────────────────────────
// Calls your existing vectorize-mcp-worker over HTTP.
// Falls back gracefully when VECTORIZE_MCP_URL is not configured.

interface VecMcpEnv {
  VECTORIZE_MCP_URL?: string | undefined;
  VECTORIZE_MCP_TOKEN?: string | undefined;
}

async function vecUpsert(
  env: VecMcpEnv,
  id: string,
  text: string,
  metadata: Record<string, string>
): Promise<string | null> {
  if (!env.VECTORIZE_MCP_URL) return null;
  try {
    const res = await fetch(`${env.VECTORIZE_MCP_URL}/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.VECTORIZE_MCP_TOKEN ?? ""}`,
      },
      body: JSON.stringify({ id, text, metadata }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { vector_id?: string };
    return data.vector_id ?? id;
  } catch {
    return null;
  }
}

async function vecSearch(
  env: VecMcpEnv,
  query: string,
  topK: number,
  sessionId?: string
): Promise<Array<{ id: string; score: number }>> {
  if (!env.VECTORIZE_MCP_URL) return [];
  try {
    const body: Record<string, unknown> = { query, top_k: topK };
    if (sessionId) body["filter"] = { session_id: sessionId };
    const res = await fetch(`${env.VECTORIZE_MCP_URL}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.VECTORIZE_MCP_TOKEN ?? ""}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{ id: string; score: number }>;
    };
    return data.results ?? [];
  } catch {
    return [];
  }
}

// ─── Store API ────────────────────────────────────────────────────────────────

export interface StoreEnv extends VecMcpEnv {
  DB: D1Database;
  DEFAULT_TTL_MS: string;
}

/** Write a new context entry. Returns the [ctx:id] token. */
export async function indexToolOutput(
  env: StoreEnv,
  opts: IndexOptions
): Promise<string> {
  const id = nanoid(10);
  const now = Date.now();
  const ttl = opts.ttl_ms ?? parseInt(env.DEFAULT_TTL_MS, 10);
  const expires_at = now + ttl;

  // Upsert session FIRST (FK constraint requires session to exist before entry)
  await env.DB.prepare(
    `INSERT INTO sessions (id, actor, created_at, last_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`
  )
    .bind(opts.session_id, opts.actor, now, now)
    .run();

  // Upsert to vectorize-mcp-worker (non-blocking — fire and forget)
  const vecPromise = vecUpsert(env, id, `${opts.intent ?? ""} ${opts.summary}`, {
    session_id: opts.session_id,
    actor: opts.actor,
    type: opts.type,
  });

  // Truncate raw_output at 512KB to stay within D1 row size limits
  const MAX_RAW_BYTES = 512 * 1024;
  let rawOutput = opts.raw_output ?? null;
  if (rawOutput !== null) {
    const encoded = new TextEncoder().encode(rawOutput);
    if (encoded.length > MAX_RAW_BYTES) {
      rawOutput = new TextDecoder().decode(encoded.slice(0, MAX_RAW_BYTES)) + "\n[truncated — output exceeded 512KB]";
    }
  }

  // Write context entry
  await env.DB.prepare(
    `INSERT INTO context_entries
       (id, session_id, actor, type, intent, summary, raw_size, raw_output, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      opts.session_id,
      opts.actor,
      opts.type,
      opts.intent ?? null,
      opts.summary,
      opts.raw_size,
      rawOutput,
      now,
      expires_at
    )
    .run();

  // Resolve vector_id and backfill (best-effort)
  vecPromise
    .then(async (vector_id) => {
      if (vector_id) {
        await env.DB.prepare(
          `UPDATE context_entries SET vector_id = ? WHERE id = ?`
        )
          .bind(vector_id, id)
          .run();
      }
    })
    .catch(() => {
      // degraded mode — vector_id stays null, BM25 still works
    });

  return id;
}

// Wrap query in double quotes for FTS5 phrase search — prevents hyphens,
// special chars, and column-name collisions from breaking the MATCH syntax.
function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

/** Hybrid search: BM25 (D1 FTS) + semantic (vectorize-mcp-worker). */
export async function searchRelevant(
  env: StoreEnv,
  query: string,
  sessionId?: string,
  limit = 5
): Promise<SearchResult[]> {
  const now = Date.now();

  // Run BM25 and vector search in parallel
  const [bm25Rows, vecResults] = await Promise.all([
    // BM25 via D1 FTS5
    (async () => {
      const clause = sessionId ? `AND e.session_id = ?` : "";
      const ftsQuery = ftsPhrase(query);
      const params: unknown[] = sessionId
        ? [ftsQuery, now, sessionId, limit * 2]
        : [ftsQuery, now, limit * 2];

      const result = await env.DB.prepare(
        `SELECT e.id, e.summary, e.type, e.created_at,
                bm25(context_fts) AS bm25_score
         FROM context_fts
         JOIN context_entries e ON context_fts.rowid = e.rowid
         WHERE context_fts MATCH ?
           AND e.expires_at > ?
           ${clause}
         ORDER BY bm25_score
         LIMIT ?`
      )
        .bind(...params)
        .all<{
          id: string;
          summary: string;
          type: EntryType;
          created_at: number;
          bm25_score: number;
        }>();
      return result.results ?? [];
    })(),
    vecSearch(env, query, limit * 2, sessionId),
  ]);

  // Merge: use a map keyed by entry id, highest score wins
  const scores = new Map<string, number>();
  for (const row of bm25Rows) {
    // bm25() returns negative values — negate to get positive relevance
    scores.set(row.id, Math.abs(row.bm25_score));
  }
  for (const v of vecResults) {
    const existing = scores.get(v.id) ?? 0;
    // Combine: BM25 + vector score, normalized 0–1
    scores.set(v.id, existing + v.score);
  }

  // Fetch full rows for all matched IDs
  const allIds = [...new Set([...bm25Rows.map((r) => r.id), ...vecResults.map((v) => v.id)])];
  if (allIds.length === 0) return [];

  const placeholders = allIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, summary, type, created_at FROM context_entries
     WHERE id IN (${placeholders}) AND expires_at > ?`
  )
    .bind(...allIds, now)
    .all<{ id: string; summary: string; type: EntryType; created_at: number }>();

  return (rows.results ?? [])
    .map((r) => ({
      ref: `[ctx:${r.id}]`,
      summary: r.summary,
      score: scores.get(r.id) ?? 0,
      type: r.type,
      created_at: r.created_at,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Retrieve a single context entry by ID. Returns null if not found or expired. */
export async function getEntryById(
  env: StoreEnv,
  id: string
): Promise<{ id: string; summary: string; raw_output: string | null; type: EntryType; created_at: number } | null> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `SELECT id, summary, raw_output, type, created_at
     FROM context_entries
     WHERE id = ? AND expires_at > ?`
  )
    .bind(id, now)
    .first<{ id: string; summary: string; raw_output: string | null; type: EntryType; created_at: number }>();
  return result ?? null;
}

/** Return chronological session history, excluding expired entries. */
export async function getSessionHistory(
  env: StoreEnv,
  sessionId: string,
  limit = 20
): Promise<ContextEntry[]> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `SELECT * FROM context_entries
     WHERE session_id = ? AND expires_at > ?
     ORDER BY created_at ASC
     LIMIT ?`
  )
    .bind(sessionId, now, limit)
    .all<ContextEntry>();
  return result.results ?? [];
}

/** Delete expired entries (called by cron). Returns purged count. */
export async function purgeOld(
  env: StoreEnv,
  opts: { session_id?: string; older_than_ms?: number } = {}
): Promise<number> {
  const cutoff = opts.older_than_ms
    ? Date.now() - opts.older_than_ms
    : Date.now();

  let stmt: D1PreparedStatement;
  if (opts.session_id) {
    stmt = env.DB.prepare(
      `DELETE FROM context_entries WHERE expires_at < ? AND session_id = ?`
    ).bind(cutoff, opts.session_id);
  } else {
    stmt = env.DB.prepare(
      `DELETE FROM context_entries WHERE expires_at < ?`
    ).bind(cutoff);
  }

  const result = await stmt.run();
  return result.meta.changes ?? 0;
}

/** Count sessions and entries for doctor tool. */
export async function getStats(
  env: StoreEnv
): Promise<{ sessions: number; entries: number }> {
  const [s, e] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM context_entries`).first<{
      n: number;
    }>(),
  ]);
  return { sessions: s?.n ?? 0, entries: e?.n ?? 0 };
}
