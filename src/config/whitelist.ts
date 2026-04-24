// Commands that ctx_execute is allowed to run.
// Anything not on this list is rejected immediately — nothing is stored.
export const ALLOWED_COMMANDS = new Set<string>([
  // File inspection
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "stat",

  // Text processing
  "echo",
  "grep",
  "sed",
  "awk",
  "jq",
  "sort",
  "uniq",
  "cut",

  // Runtime execution (output-minimal scripts only)
  "node",
  "bun",
  "python3",
  "tsx",
  "deno",

  // Package inspection (read-only)
  "npm",   // only npm list, npm view — enforced in executor
  "npx",

  // Version control (read-only)
  "git",   // only git log, git diff, git status — enforced in executor

  // Network / data fetch (no arbitrary URLs in prod)
  "curl",

  // System info
  "env",
  "printenv",
  "date",
  "uptime",
  "df",
  "du",
]);

// Subcommand restrictions for potentially dangerous base commands.
// If a command is listed here, only these subcommands are allowed.
export const SUBCOMMAND_ALLOWLIST: Record<string, Set<string>> = {
  git: new Set(["log", "diff", "status", "show", "ls-files", "blame", "shortlog"]),
  npm: new Set(["list", "view", "info", "pack", "--version"]),
};
