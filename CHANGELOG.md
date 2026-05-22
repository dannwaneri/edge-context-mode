# Changelog

## [1.0.0] — 2026-05-22

First stable release. This version finishes what the initial commit started.

### Added

- **`ctx_get` tool** — dereference any `[ctx:id]` token to retrieve the stored summary and full raw output. Accepts both `[ctx:abc123]` and bare `abc123` formats. Returns "Entry not found or expired." for unknown or TTL-expired IDs.
- **`ctx_annotate` tool** — manually write a decision, note, or code snippet to session context without running a shell command. Stored with `type: "annotation"`, retrievable via `ctx_get` and `ctx_search`.
- **`raw_output` column** (migration `0002_raw_output.sql`) — full command stdout is now stored in D1 (capped at 512KB). Pre-existing entries retain `NULL` for this field gracefully.
- **`annotation` entry type** — added to the D1 `CHECK` constraint alongside `tool_output`, `prompt`, `decision`, `event`.
- **`execution_mode` field in `ctx_doctor`** — reports `"local-stdio"` or `"workers-http"` so you always know which mode is active.

### Changed

- **`ctx_execute` in Workers HTTP mode** now returns an honest, actionable error instead of a silent placeholder from the Durable Object stub. The error message includes the exact `claude mcp add` command to run local mode.
- **`ctx_doctor` vectorize status** now reports `"disabled (optional)"` instead of `"unconfigured"` when `VECTORIZE_MCP_URL` is not set — clarifying that Vectorize is an optional upgrade, not a missing requirement.
- **README rewritten** — local quick-start (zero cloud setup, 4 commands) is now the primary path. Vectorize and Workers deployment moved to separate sections. Known limitation of `ctx_execute` in Workers mode is documented clearly.
- **`wrangler.jsonc`** — Vectorize secrets marked as `OPTIONAL` in comments. Only `MCP_SECRET` is required for Workers deployment.

### Known limitations

- `ctx_execute` requires local-stdio mode. Cloudflare Workers cannot spawn subprocesses. All read/search/annotate tools work in Workers HTTP mode.
- Vectorize semantic search requires a separately deployed `vectorize-mcp-worker`. BM25 (D1 FTS5) works without it.

## [0.1.0] — 2026-04-15

Initial release. Core MCP server with `ctx_execute`, `ctx_search`, `ctx_history`, `ctx_purge`, `ctx_reflect`, `ctx_doctor`. Cloudflare Workers + Durable Objects + D1 + optional Vectorize.
