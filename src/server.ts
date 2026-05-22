import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Hono } from "hono";

import type { Env, DoctorResult } from "./types.js";
import { ExecutorDO } from "./do/ExecutorDO.js";
import { ctxExecute } from "./tools/executor.js";
import { ctxReflect } from "./tools/reflect.js";
import {
  searchRelevant,
  getSessionHistory,
  getEntryById,
  purgeOld,
  getStats,
} from "./tools/store.js";

export { ExecutorDO };

// ─── MCP Server factory ───────────────────────────────────────────────────────

const SERVER_START_MS = Date.now();

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "edge-context-mode",
    version: "0.1.0",
  });

  // ── ctx_execute ─────────────────────────────────────────────────────────────
  server.tool(
    "ctx_execute",
    "Run a sandboxed command. Returns only a [ctx:id] reference + summary — raw output never enters LLM context. Think in Code: write scripts that output minimal, structured results.",
    {
      command: z.string().describe("Shell command to run (must be on whitelist)"),
      intent: z.string().describe("Why you are running this command (used for search)"),
      session_id: z.string().optional().describe("Session ID for attribution (default: 'default')"),
      actor: z.string().optional().describe("Who is running this (default: 'agent')"),
      timeout: z.number().optional().describe("Timeout in ms (max 30000)"),
    },
    async (_input) => {
      // ctx_execute requires local-stdio mode — Cloudflare Workers cannot spawn
      // subprocesses. Run the local stdio server instead:
      //   npm run local
      //   claude mcp add edge-context-mode -- node /path/to/edge-context-mode/src/local.ts
      //
      // All other tools (ctx_get, ctx_search, ctx_history, ctx_annotate,
      // ctx_reflect, ctx_doctor) work normally in Workers HTTP mode.
      return {
        content: [{
          type: "text",
          text: [
            "ctx_execute is not available in Workers HTTP mode.",
            "Cloudflare Workers cannot spawn subprocesses.",
            "",
            "To use ctx_execute, run the local stdio server:",
            "  npm run local",
            "  claude mcp add edge-context-mode -- node /path/to/edge-context-mode/src/local.ts",
            "",
            "All other tools work normally in Workers HTTP mode.",
          ].join("\n"),
        }],
        isError: true,
      };
    }
  );

  // ── ctx_get ─────────────────────────────────────────────────────────────────
  server.tool(
    "ctx_get",
    "Retrieve the summary and raw output stored behind a [ctx:id] reference. Use this when the summary alone isn't enough.",
    {
      id: z.string().describe("The [ctx:id] token or bare ID to look up"),
    },
    async ({ id }) => {
      // Strip [ctx:] prefix if present
      const bareId = id.replace(/^\[ctx:/, "").replace(/\]$/, "");
      const entry = await getEntryById(env, bareId);
      if (!entry) {
        return { content: [{ type: "text", text: "Entry not found or expired." }] };
      }
      const lines = [
        `ref:        [ctx:${entry.id}]`,
        `type:       ${entry.type}`,
        `created_at: ${new Date(entry.created_at).toISOString()}`,
        `summary:    ${entry.summary}`,
        entry.raw_output !== null
          ? `\n--- raw output ---\n${entry.raw_output}`
          : `\n(raw output not available for this entry)`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── ctx_annotate ─────────────────────────────────────────────────────────────
  server.tool(
    "ctx_annotate",
    "Manually save a decision, note, or code snippet to session context. Returns a [ctx:id] reference like ctx_execute does.",
    {
      text: z.string().min(1).max(10_000).describe("The annotation text — a decision, note, or snippet"),
      session_id: z.string().optional().describe("Session to attach this to (default: 'default')"),
      actor: z.string().optional().describe("Who is annotating (default: 'user')"),
    },
    async ({ text, session_id = "default", actor = "user" }) => {
      const { indexToolOutput } = await import("./tools/store.js");
      const summary = `annotation: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`;
      const ref_id = await indexToolOutput(env, {
        session_id,
        actor,
        type: "annotation",
        intent: "manual annotation",
        summary,
        raw_size: new TextEncoder().encode(text).length,
        raw_output: text,
      });
      return { content: [{ type: "text", text: `[ctx:${ref_id}]\n${summary}` }] };
    }
  );

  // ── ctx_search ──────────────────────────────────────────────────────────────
  server.tool(
    "ctx_search",
    "Search session context using hybrid BM25 + semantic search. Returns ranked references and summaries.",
    {
      query: z.string().describe("Natural language query"),
      session_id: z.string().optional().describe("Limit to a specific session"),
      limit: z.number().optional().describe("Max results (default 5)"),
    },
    async ({ query, session_id, limit = 5 }) => {
      const results = await searchRelevant(env, query, session_id, limit);
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching context found." }] };
      }
      const lines = results.map(
        (r) => `${r.ref} [score:${r.score.toFixed(2)}] ${r.summary}`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── ctx_history ─────────────────────────────────────────────────────────────
  server.tool(
    "ctx_history",
    "Retrieve chronological session history. Excludes expired entries.",
    {
      session_id: z.string().describe("Session ID to retrieve"),
      limit: z.number().optional().describe("Max entries (default 20)"),
    },
    async ({ session_id, limit = 20 }) => {
      const entries = await getSessionHistory(env, session_id, limit);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No history for this session." }] };
      }
      const lines = entries.map(
        (e) => `[ctx:${e.id}] [${e.type}] ${e.summary}`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── ctx_purge ───────────────────────────────────────────────────────────────
  server.tool(
    "ctx_purge",
    "Delete expired or old context entries. Use to free storage.",
    {
      session_id: z.string().optional().describe("Limit purge to a session"),
      older_than_ms: z.number().optional().describe("Delete entries older than N ms"),
    },
    async ({ session_id, older_than_ms }) => {
      const purgeOpts: { session_id?: string; older_than_ms?: number } = {};
      if (session_id !== undefined) purgeOpts.session_id = session_id;
      if (older_than_ms !== undefined) purgeOpts.older_than_ms = older_than_ms;
      const count = await purgeOld(env, purgeOpts);
      return { content: [{ type: "text", text: `Purged ${count} entries.` }] };
    }
  );

  // ── ctx_reflect ─────────────────────────────────────────────────────────────
  server.tool(
    "ctx_reflect",
    "Get a ≤100-word narrative reflection of the session so far. No side effects.",
    {
      session_id: z.string().describe("Session ID to reflect on"),
      prompt: z.string().optional().describe("Optional focus for the reflection"),
    },
    async ({ session_id, prompt }) => {
      const reflection = await ctxReflect(env, session_id, prompt);
      return { content: [{ type: "text", text: reflection }] };
    }
  );

  // ── ctx_doctor ──────────────────────────────────────────────────────────────
  server.tool(
    "ctx_doctor",
    "Health check: D1 status, vectorize-mcp status, session + entry counts, uptime.",
    {},
    async () => {
      // D1 ping
      let d1: DoctorResult["d1"] = "ok";
      try {
        await env.DB.prepare("SELECT 1").first();
      } catch {
        d1 = "error";
      }

      // Vectorize-mcp-worker ping (optional — degrades gracefully to BM25-only)
      let vectorize_mcp: DoctorResult["vectorize_mcp"] = "disabled (optional)";
      if (env.VECTORIZE_MCP_URL) {
        try {
          const res = await fetch(`${env.VECTORIZE_MCP_URL}/health`, {
            headers: { Authorization: `Bearer ${env.VECTORIZE_MCP_TOKEN ?? ""}` },
          });
          vectorize_mcp = res.ok ? "ok" : "degraded";
        } catch {
          vectorize_mcp = "degraded";
        }
      }

      const { sessions, entries } = await getStats(env);

      const result: DoctorResult = {
        d1,
        vectorize_mcp,
        execution_mode: "workers-http",
        sessions,
        entries,
        uptime_ms: Date.now() - SERVER_START_MS,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function checkSecret(request: Request, env: Env): boolean {
  if (!env.MCP_SECRET) return true; // unconfigured = open (local dev)
  const header = request.headers.get("x-mcp-secret");
  return header === env.MCP_SECRET;
}

// ─── Hono HTTP app (Workers) ──────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>edge-context-mode</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f0f10; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card { max-width: 560px; width: 100%; }
    h1 { font-size: 1.4rem; font-weight: 600; color: #fff; margin-bottom: .4rem; }
    .tag { display: inline-block; font-size: .75rem; background: #1a1a2e; color: #60a5fa; border: 1px solid #2a2a4e; border-radius: 4px; padding: .15rem .5rem; margin-bottom: 1.2rem; }
    p { color: #999; font-size: .9rem; line-height: 1.6; margin-bottom: 1.2rem; }
    .tools { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-bottom: 1.4rem; }
    .tool { background: #18181b; border: 1px solid #27272a; border-radius: 6px; padding: .5rem .75rem; font-size: .8rem; }
    .tool code { color: #60a5fa; font-family: "SF Mono", Consolas, monospace; }
    .tool span { color: #666; display: block; margin-top: .15rem; }
    .links { display: flex; gap: 1rem; flex-wrap: wrap; }
    .links a { font-size: .85rem; color: #60a5fa; text-decoration: none; border-bottom: 1px solid rgba(96,165,250,.3); padding-bottom: 1px; }
    .links a:hover { border-bottom-color: #60a5fa; }
    .endpoint { background: #18181b; border: 1px solid #27272a; border-radius: 6px; padding: .6rem .9rem; font-size: .8rem; color: #666; margin-bottom: 1.4rem; }
    .endpoint code { color: #a3e635; font-family: "SF Mono", Consolas, monospace; }
    hr { border: none; border-top: 1px solid #27272a; margin: 1.2rem 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>edge-context-mode</h1>
    <span class="tag">MCP Server · Cloudflare Workers</span>
    <p>Keeps Claude Code sessions coherent over hours. Every tool call stores raw output in D1 — only a reference token and a 50-word summary enter the context window.</p>
    <div class="tools">
      <div class="tool"><code>ctx_execute</code><span>Run a command, store output</span></div>
      <div class="tool"><code>ctx_get</code><span>Retrieve stored output by ref</span></div>
      <div class="tool"><code>ctx_annotate</code><span>Save a decision or note</span></div>
      <div class="tool"><code>ctx_search</code><span>Full-text search over session</span></div>
      <div class="tool"><code>ctx_history</code><span>Chronological session log</span></div>
      <div class="tool"><code>ctx_reflect</code><span>Session summary ≤100 words</span></div>
    </div>
    <div class="endpoint">MCP endpoint: <code>POST /mcp</code> · requires <code>X-MCP-Secret</code></div>
    <hr />
    <div class="links">
      <a href="https://github.com/dannwaneri/edge-context-mode" target="_blank">GitHub</a>
      <a href="https://github.com/dannwaneri/edge-context-mode/releases/tag/v1.0.0" target="_blank">v1.0.0 release</a>
      <a href="/health">health check</a>
    </div>
  </div>
</body>
</html>`);
});

app.get("/health", (c) => {
  return c.json({ status: "ok", ts: Date.now() });
});

app.all("/mcp", async (c) => {
  if (!checkSecret(c.req.raw, c.env)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const server = createMcpServer(c.env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    // sessionIdGenerator omitted — stateless mode for ephemeral Workers
  });

  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

// ─── Workers export ───────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,

  // Cron trigger — purge expired entries every 6 hours
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      purgeOld(env, { older_than_ms: parseInt(env.DEFAULT_TTL_MS, 10) }).then(
        (n) => console.log(`[cron] purged ${n} expired entries`)
      )
    );
  },
} satisfies ExportedHandler<Env>;
