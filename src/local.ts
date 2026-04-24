// Local stdio entry point — used by: npm run local
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { readdir, readFile } from "fs/promises";

import type { LocalExecFn } from "./tools/executor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .dev.vars so VECTORIZE_MCP_URL etc. are available without wrangler
async function loadDevVars() {
  const devVarsPath = path.join(__dirname, "..", ".dev.vars");
  try {
    const contents = await readFile(devVarsPath, "utf8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* .dev.vars is optional */ }
}
const DB_PATH = path.join(__dirname, "..", ".wrangler", "state", "v3", "d1", "edge-context-db.sqlite3");

// ─── Local exec fn (injected into ctxExecute) ────────────────────────────────

const localExecFn: LocalExecFn = (binary, args, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let timedOut = false;

    // shell: true required on Windows to resolve PATH binaries (node, git, etc.)
    const child = spawn(binary, args, { shell: process.platform === "win32" });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      resolve({ stdout: "", exit_code: 124, timed_out: true });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stdout += d.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!timedOut) resolve({ stdout, exit_code: code ?? 0, timed_out: false });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: err.message, exit_code: 1, timed_out: false });
    });
  });

// ─── Local SQLite shim (mirrors D1 interface) ─────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(DB_PATH, { fileMustExist: false });
  db.pragma("journal_mode = WAL");
  return db;
}

async function buildLocalEnv() {
  const db = openDb();

  const migrationsDir = path.join(__dirname, "..", "migrations");
  const files = (await readdir(migrationsDir)).sort();
  for (const f of files) {
    if (!f.endsWith(".sql")) continue;
    const sql = await readFile(path.join(migrationsDir, f), "utf8");
    try { db.exec(sql); } catch { /* already applied */ }
  }

  return {
    DB: createD1Shim(db),
    EXECUTOR_DO: null as unknown as DurableObjectNamespace,
    ENVIRONMENT: "local",
    DEFAULT_TTL_MS: "2592000000",
    MAX_EXEC_TIMEOUT_MS: "30000",
    MCP_SECRET: process.env["MCP_SECRET"],
    VECTORIZE_MCP_URL: process.env["VECTORIZE_MCP_URL"],
    VECTORIZE_MCP_TOKEN: process.env["VECTORIZE_MCP_TOKEN"],
  };
}

function createD1Shim(db: Database.Database) {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          const stmt = db.prepare(sql);
          const info = stmt.run(...(params as Parameters<typeof stmt.run>));
          return { meta: { changes: info.changes } };
        },
        first: async <T>(): Promise<T | null> =>
          (db.prepare(sql).get(...(params as Parameters<typeof db.prepare>)) as T) ?? null,
        all: async <T>(): Promise<{ results: T[] }> =>
          ({ results: db.prepare(sql).all(...(params as Parameters<typeof db.prepare>)) as T[] }),
      }),
      first: async <T>(): Promise<T | null> =>
        (db.prepare(sql).get() as T) ?? null,
    }),
    exec: async (s: string) => { db.exec(s); },
    batch: async () => [],
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await loadDevVars();
  const env = await buildLocalEnv();

  const { ctxExecute } = await import("./tools/executor.js");
  const { ctxReflect } = await import("./tools/reflect.js");
  const { searchRelevant, getSessionHistory, purgeOld, getStats } = await import("./tools/store.js");

  // Cast through unknown — local SQLite shim satisfies the runtime contract
  // even though it doesn't implement rarely-used D1 methods (dump, withSession).
  type Env = typeof env & { DB: D1Database };

  const server = new McpServer({ name: "edge-context-mode", version: "0.1.0" });

  server.tool("ctx_execute", "Sandboxed command execution. Returns [ctx:id] reference only.", {
    command: z.string(),
    intent: z.string(),
    session_id: z.string().optional(),
    actor: z.string().optional(),
    timeout: z.number().optional(),
  }, async (input) => {
    const result = await ctxExecute(env as unknown as Env, {
      command: input.command,
      intent: input.intent,
      ...(input.session_id !== undefined && { session_id: input.session_id }),
      ...(input.actor !== undefined && { actor: input.actor }),
      ...(input.timeout !== undefined && { timeout: input.timeout }),
    }, localExecFn);
    if ("error" in result) return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    return { content: [{ type: "text", text: `${result.ref}\n${result.summary}` }] };
  });

  server.tool("ctx_search", "Hybrid BM25 + semantic search over session context.", {
    query: z.string(),
    session_id: z.string().optional(),
    limit: z.number().optional(),
  }, async ({ query, session_id, limit = 5 }) => {
    const results = await searchRelevant(env as unknown as Env, query, session_id, limit);
    if (results.length === 0) return { content: [{ type: "text", text: "No matching context found." }] };
    return { content: [{ type: "text", text: results.map(r => `${r.ref} ${r.summary}`).join("\n") }] };
  });

  server.tool("ctx_history", "Retrieve session history.", {
    session_id: z.string(),
    limit: z.number().optional(),
  }, async ({ session_id, limit = 20 }) => {
    const entries = await getSessionHistory(env as unknown as Env, session_id, limit);
    if (entries.length === 0) return { content: [{ type: "text", text: "No history." }] };
    return { content: [{ type: "text", text: entries.map(e => `[ctx:${e.id}] [${e.type}] ${e.summary}`).join("\n") }] };
  });

  server.tool("ctx_purge", "Purge old context entries.", {
    session_id: z.string().optional(),
    older_than_ms: z.number().optional(),
  }, async (input) => {
    const purgeOpts: { session_id?: string; older_than_ms?: number } = {};
    if (input.session_id !== undefined) purgeOpts.session_id = input.session_id;
    if (input.older_than_ms !== undefined) purgeOpts.older_than_ms = input.older_than_ms;
    const n = await purgeOld(env as unknown as Env, purgeOpts);
    return { content: [{ type: "text", text: `Purged ${n} entries.` }] };
  });

  server.tool("ctx_reflect", "Get a session narrative (≤100 words).", {
    session_id: z.string(),
    prompt: z.string().optional(),
  }, async ({ session_id, prompt }) => {
    const reflection = await ctxReflect(env as unknown as Env, session_id, prompt);
    return { content: [{ type: "text", text: reflection }] };
  });

  server.tool("ctx_doctor", "Health check.", {}, async () => {
    const { sessions, entries } = await getStats(env as unknown as Env);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          d1: "ok",
          vectorize_mcp: env.VECTORIZE_MCP_URL ? "configured" : "unconfigured",
          sessions,
          entries,
        }, null, 2),
      }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[edge-context-mode] MCP server running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
