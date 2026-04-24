# edge-context-mode

Cloudflare-native MCP server that sandboxes every tool call and stores only minimal summaries in LLM context. Long sessions, no context overflow.

## How it works

```
ctx_execute(command) → runs in sandbox → stores raw output in D1 → returns [ctx:abc123] + ≤50-word summary
```

The LLM context never sees raw output — only the reference token and summary.

## Prerequisites

- Cloudflare account with Workers Paid plan (Durable Objects)
- D1 database created: `wrangler d1 create edge-context-db`
- `vectorize-mcp-worker` deployed (for semantic search — optional but recommended)
- Node.js 20+ or Bun

## Setup

```bash
cd edge-context-mode
npm install

# Apply D1 schema locally
npm run migrate:local

# Copy the database_id from `wrangler d1 create` output into wrangler.jsonc
```

## Secrets

```bash
wrangler secret put MCP_SECRET             # shared secret for X-MCP-Secret header
wrangler secret put VECTORIZE_MCP_URL      # your vectorize-mcp-worker URL
wrangler secret put VECTORIZE_MCP_TOKEN    # bearer token for vectorize-mcp-worker
```

For local mode, set these in a `.dev.vars` file:

```
MCP_SECRET=your-secret
VECTORIZE_MCP_URL=https://your-vectorize-mcp-worker.workers.dev
VECTORIZE_MCP_TOKEN=your-token
```

## Running locally (Claude Code integration)

```bash
npm run local
```

Then register with Claude Code:

```bash
claude mcp add edge-context-mode -- node /path/to/edge-context-mode/src/local.ts
# or with Bun:
claude mcp add edge-context-mode -- bun /path/to/edge-context-mode/src/local.ts
```

## Running on Cloudflare Workers

```bash
npm run deploy
```

Register the deployed URL with Claude Code:

```bash
claude mcp add edge-context-mode \
  --transport http \
  --url https://edge-context-mode.your-subdomain.workers.dev/mcp \
  --header "x-mcp-secret: YOUR_SECRET"
```

## Tools

| Tool | Description |
|---|---|
| `ctx_execute` | Sandboxed command execution. Returns `[ctx:id]` reference + summary only. |
| `ctx_search` | Hybrid BM25 + semantic search over session context. |
| `ctx_history` | Chronological session history, non-expired entries only. |
| `ctx_purge` | Delete expired or old context entries. |
| `ctx_reflect` | ≤100-word narrative reflection of a session. No side effects. |
| `ctx_doctor` | Health check: D1 status, vectorize-mcp status, counts, uptime. |

## Command whitelist

Only commands in `src/config/whitelist.ts` are allowed. Edit the `ALLOWED_COMMANDS` set to add/remove. Git and npm are further restricted by `SUBCOMMAND_ALLOWLIST`.

## Think in Code

Instead of asking for all files and summarising yourself:

```
# Bad: returns 10,000 lines into context
ctx_execute("cat large-file.json", "inspect config")

# Good: write a script that outputs 3 structured lines
ctx_execute("node -e \"const d=require('./large-file.json'); console.log(JSON.stringify({keys: Object.keys(d).length, topLevel: Object.keys(d).slice(0,5)}))\"", "inspect config shape")
```

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
│   │   └── ExecutorDO.ts  # Durable Object for Workers isolation
│   └── tools/
│       ├── executor.ts    # ctx_execute implementation
│       ├── store.ts       # Hybrid D1 + vectorize-mcp-worker store
│       └── reflect.ts     # ctx_reflect implementation
├── migrations/
│   └── 0001_initial.sql   # D1 schema
├── wrangler.jsonc
├── package.json
├── tsconfig.json
└── CLAUDE.md
```
