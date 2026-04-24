// Context Savings Benchmark
// Measures token reduction when using ctx_execute vs raw Bash output
// Run: npx tsx scripts/benchmark.ts

import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ─── Token estimator (GPT-style: ~4 chars per token) ─────────────────────────
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Run a shell command and capture stdout ───────────────────────────────────
function runRaw(command: string): string {
  try {
    return execSync(command, { cwd: ROOT, encoding: "utf8", timeout: 15000 });
  } catch (err: unknown) {
    const e = err as { stdout?: string; message?: string };
    return e.stdout ?? e.message ?? "ERROR";
  }
}

// ─── Simulate ctx_execute summary (what would enter LLM context) ─────────────
function simulateSummary(stdout: string, intent: string): string {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return `(no output) — ${intent}`;
  const preview = lines.slice(0, 5).join(" | ");
  const truncated = preview.length > 300 ? preview.slice(0, 300) + "…" : preview;
  return `[ctx:xxxxxxxxxx]\n${lines.length} line(s): ${truncated}`;
}

// ─── Benchmark cases ──────────────────────────────────────────────────────────
const cases: Array<{ label: string; command: string; intent: string }> = [
  {
    label: "git log (last 20 commits)",
    command: "git log --oneline -20",
    intent: "review recent commit history",
  },
  {
    label: "package.json full read",
    command: `node -e "console.log(require('./package.json', {assert:{type:'json'}}));" 2>/dev/null || type package.json`,
    intent: "inspect project dependencies",
  },
  {
    label: "npm list (dependency tree)",
    command: "npm list --depth=1",
    intent: "check installed packages",
  },
  {
    label: "wrangler.jsonc full read",
    command: "node -e \"const fs=require('fs');console.log(fs.readFileSync('wrangler.jsonc','utf8'))\"",
    intent: "inspect wrangler config",
  },
  {
    label: "src directory tree",
    command: "node -e \"const fs=require('fs'),p=require('path');function walk(d,i=''){const items=fs.readdirSync(d);items.forEach(f=>{console.log(i+f);const fp=p.join(d,f);if(fs.statSync(fp).isDirectory())walk(fp,i+'  ');})}walk('src')\"",
    intent: "explore project structure",
  },
  {
    label: "store.ts full file read",
    command: "node -e \"const fs=require('fs');console.log(fs.readFileSync('src/tools/store.ts','utf8'))\"",
    intent: "read hybrid store implementation",
  },
];

// ─── Run benchmark ────────────────────────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════════════════════════╗");
console.log("║           edge-context-mode — Context Savings Benchmark         ║");
console.log("╚══════════════════════════════════════════════════════════════════╝\n");

const MCP_OVERHEAD = estimateTokens("[ctx:xxxxxxxxxx]\n42 line(s): sample summary text here…");

let totalRaw = 0;
let totalCtx = 0;

const rows: Array<{
  label: string;
  rawTokens: number;
  ctxTokens: number;
  saving: number;
}> = [];

for (const c of cases) {
  const raw = runRaw(c.command);
  const summary = simulateSummary(raw, c.intent);

  const rawTokens = estimateTokens(raw);
  const ctxTokens = estimateTokens(summary) + MCP_OVERHEAD;
  const saving = Math.round(((rawTokens - ctxTokens) / rawTokens) * 100);

  totalRaw += rawTokens;
  totalCtx += ctxTokens;

  rows.push({ label: c.label, rawTokens, ctxTokens, saving });
}

// ─── Print table ──────────────────────────────────────────────────────────────
const COL = [38, 10, 10, 10];
const header = [
  "Command".padEnd(COL[0]!),
  "Raw tkns".padStart(COL[1]!),
  "Ctx tkns".padStart(COL[2]!),
  "Saving".padStart(COL[3]!),
].join("  ");

console.log(header);
console.log("─".repeat(header.length));

for (const r of rows) {
  const savingStr = `${r.saving}%`;
  const flag = r.saving >= 80 ? " 🟢" : r.saving >= 50 ? " 🟡" : " 🔴";
  console.log(
    [
      r.label.slice(0, COL[0]!).padEnd(COL[0]!),
      r.rawTokens.toLocaleString().padStart(COL[1]!),
      r.ctxTokens.toLocaleString().padStart(COL[2]!),
      (savingStr + flag).padStart(COL[3]! + 3),
    ].join("  ")
  );
}

console.log("─".repeat(header.length));

const totalSaving = Math.round(((totalRaw - totalCtx) / totalRaw) * 100);
console.log(
  [
    "TOTAL".padEnd(COL[0]!),
    totalRaw.toLocaleString().padStart(COL[1]!),
    totalCtx.toLocaleString().padStart(COL[2]!),
    `${totalSaving}%`.padStart(COL[3]!),
  ].join("  ")
);

console.log(`
Summary
───────
Raw output would consume  : ${totalRaw.toLocaleString()} tokens
ctx_execute consumes      : ${totalCtx.toLocaleString()} tokens
Tokens saved              : ${(totalRaw - totalCtx).toLocaleString()}
Overall reduction         : ${totalSaving}%

At $3/M tokens (Claude Sonnet) that's ~$${(((totalRaw - totalCtx) / 1_000_000) * 3).toFixed(4)} saved per benchmark run.
Across 100 sessions/month: ~$${((((totalRaw - totalCtx) / 1_000_000) * 3) * 100).toFixed(2)}/month saved.
`);
