# edge-context-mode

Cloudflare-native MCP server that stops LLM context overflow. Every tool call is sandboxed — only a `[ctx:id]` reference token and a ≤50-word summary enter your context window. The full output is stored in D1 and retrievable on demand.

## How it works

```
ctx_execute(command) → sandboxed execution → D1 stores full output → LLM sees [ctx:abc123] + ≤50-word summary
ctx_get([ctx:abc123]) → retrieves full output on demand
ctx_annotate(text)   → saves a decision or note as a context entry
ctx_search(query)    → hybrid BM25 + semantic search over session history
```

Raw output **never** enters the LLM context automatically. You pull it when you need it.

---

## Quick start — local (no cloud required)

> Runs on your machine via stdio. Zero Cloudflare setup needed.

**Prerequisites:** Node.js 20+

```bash
git clone https://github.com/dannwaneri/edge-context-mode
cd edge-context-mode
npm install
npm run migrate:local   # creates the local SQLite database
npm run local           # starts the MCP server on stdio
```

Register with Claude Code:

```bash
claude mcp add edge-context-mode -- node /path/to/edge-context-mode/src/local.ts
# or with Bun:
claude mcp add edge-context-mode -- bun /path/to/edge-context-mode/src/local.ts
```

Verify it's working:

```
ctx_doctor → { "d1": "ok", "execution_mode": "local-stdio", ... }
```

That's it. No secrets, no Cloudflare account, no Vectorize.

---

## Quick start — Cloudflare Workers (global edge deployment)

> Deploy to Cloudflare for persistent cross-machine context. Requires a Cloudflare account with Workers Paid plan (for Durable Objects).

```bash
# 1. Create a D1 database
wrangler d1 create edge-context-db
# Copy the database_id into wrangler.jsonc

# 2. Apply migrations
wrangler d1 migrations apply edge-context-db --remote

# 3. Set the required secret
wrangler secret put MCP_SECRET

# 4. Deploy
npm run deploy
```

Register with Claude Code:

```bash
claude mcp add edge-context-mode \
  --transport http \
  --url https://edge-context-mode.your-subdomain.workers.dev/mcp \
  --header "x-mcp-secret: YOUR_SECRET"
```

> **Note:** `ctx_execute` is not available in Workers HTTP mode — Cloudflare Workers cannot spawn subprocesses. All other tools work. Run the local stdio server alongside for execution.

---

## Tools

| Tool | Description |
|---|---|
| `ctx_execute` | Sandboxed command execution. Returns `[ctx:id]` + summary. **Local mode only.** |
| `ctx_get` | Retrieve the full output behind a `[ctx:id]` reference. |
| `ctx_annotate` | Save a decision, note, or snippet to session context manually. |
| `ctx_search` | Hybrid BM25 + semantic search over session history. |
| `ctx_history` | Chronological session entries, non-expired only. |
| `ctx_purge` | Delete expired or old context entries. |
| `ctx_reflect` | ≤100-word narrative summary of a session. No side effects. |
| `ctx_doctor` | Health check: D1 status, execution mode, entry counts, uptime. |

---

## Optional: semantic search upgrade (Vectorize)

By default, `ctx_search` uses BM25 full-text search over D1. This works well for most sessions.

To enable hybrid BM25 + semantic vector search, deploy a `vectorize-mcp-worker` and set:

```bash
# For local mode — add to .dev.vars:
VECTORIZE_MCP_URL=https://your-vectorize-mcp-worker.workers.dev
VECTORIZE_MCP_TOKEN=your-token

# For Workers mode:
wrangler secret put VECTORIZE_MCP_URL
wrangler secret put VECTORIZE_MCP_TOKEN
```

`ctx_doctor` will show `"vectorize_mcp": "ok"` when it's connected, or `"disabled (optional)"` when not configured.

---

## Think in Code

The key pattern for getting the most out of edge-context-mode:

```
# Instead of reading a file and summarising it yourself (floods context):
ctx_execute("cat large-config.json", "read full config")

# Write a script that extracts only what you need (3 lines into context):
ctx_execute(
  "node -e \"const d=require('./large-config.json'); console.log(JSON.stringify({keys: Object.keys(d).length, topLevel: Object.keys(d).slice(0,5)}))\"",
  "inspect config shape"
)
```

The LLM context gets a reference + a short summary. If you need to go deeper, call `ctx_get` on that reference.

---

## Command whitelist

Only commands in `src/config/whitelist.ts` are allowed in `ctx_execute`. Edit `ALLOWED_COMMANDS` to add/remove. `git` and `npm` are further restricted by `SUBCOMMAND_ALLOWLIST`.

---

## Project structure

```
edge-context-mode/
├── src/
│   ├── server.ts          # Workers HTTP entry + MCP tool registration
│   ├── local.ts           # Local stdio entry (Claude Code CLI)
│   ├── types.ts           # Shared TypeScript types
│   ├── config/
│   │   └── whitelist.ts   # Command allowlist
│   ├── do/
│   │   └── ExecutorDO.ts  # Durable Object (Workers isolation boundary)
│   └── tools/
│       ├── executor.ts    # ctx_execute implementation
│       ├── store.ts       # D1 store + hybrid BM25/vector search
│       └── reflect.ts     # ctx_reflect implementation
├── migrations/
│   ├── 0001_initial.sql   # D1 schema
│   └── 0002_raw_output.sql # raw_output column + annotation type
├── wrangler.jsonc
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

---

## Dev commands

```bash
npm run local          # Start local stdio MCP server
npm run dev            # Wrangler dev (Workers HTTP mode)
npm run deploy         # Deploy to Cloudflare Workers
npm run type-check     # TypeScript type check
npm run migrate:local  # Apply D1 migrations locally
```
