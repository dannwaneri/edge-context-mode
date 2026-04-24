# Edge Context Mode — Project Rules

**Project:** edge-context-mode
**Goal:** Build the best edge-native context optimization MCP server.

## Non-negotiable rules

1. **Minimal context, always.** Every tool call must return a `[ctx:id]` reference + ≤50-word summary. Never let raw output reach the LLM.

2. **Sandbox + store pattern.** All executions go through `ctxExecute` → `indexToolOutput` → return ref. There are no exceptions.

3. **Think in Code.** Prefer writing scripts that output 1–5 structured lines over processing data inside the LLM. If you catch yourself summarising large output, write a script to produce a smaller output instead.

4. **No heavy deps.** Every package must be compatible with Cloudflare Workers. Check `compatibility_date` and `nodejs_compat` requirements before adding anything.

5. **Security first.** Never expand the command whitelist without a comment explaining why. Never interpolate user input into shell strings — always use `execa(binary, args[])`.

6. **Document every new tool.** Add a one-line description to the `server.tool(...)` call and update `README.md`. No undocumented tools.

## Dev commands

```bash
cd edge-context-mode

# Local MCP on stdio (connects to Claude Code)
npm run local

# Wrangler dev (Workers HTTP mode)
npm run dev

# Deploy to Cloudflare
npm run deploy

# Type check
npm run type-check

# Apply migrations locally
npm run migrate:local
```

## Adding a new tool

1. Define input/output types in `src/types.ts`
2. Implement logic in `src/tools/`
3. Register in both `src/server.ts` and `src/local.ts`
4. Add a description to `README.md`
5. Always route through the store — never return raw data
