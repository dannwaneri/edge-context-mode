import type { Env, ExecuteInput, ExecuteResult } from "../types.js";
import { ALLOWED_COMMANDS, SUBCOMMAND_ALLOWLIST } from "../config/whitelist.js";
import { indexToolOutput } from "./store.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const SUMMARY_MAX_CHARS = 300;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  exit_code: number;
  timed_out: boolean;
}

// Injected by caller — local.ts passes execa-based fn, Workers uses DO.
export type LocalExecFn = (
  binary: string,
  args: string[],
  timeoutMs: number
) => Promise<ExecResult>;

// ─── Command validation ───────────────────────────────────────────────────────

interface ParsedCommand {
  binary: string;
  args: string[];
}

function parseCommand(raw: string): ParsedCommand {
  const parts = raw.trim().split(/\s+/);
  const binary = parts[0] ?? "";
  const args = parts.slice(1);
  return { binary, args };
}

function validateCommand(binary: string, args: string[]): string | null {
  if (!ALLOWED_COMMANDS.has(binary)) {
    return `COMMAND_NOT_ALLOWED: '${binary}' is not on the whitelist`;
  }
  const subAllowlist = SUBCOMMAND_ALLOWLIST[binary];
  if (subAllowlist) {
    const sub = args[0];
    if (!sub || !subAllowlist.has(sub)) {
      return `COMMAND_NOT_ALLOWED: '${binary} ${sub ?? ""}' subcommand not permitted`;
    }
  }
  for (const arg of args) {
    if (arg.includes("../") || arg.startsWith("/etc") || arg.startsWith("/proc")) {
      return `COMMAND_NOT_ALLOWED: path traversal or sensitive path blocked`;
    }
  }
  return null;
}

// ─── Summary truncation ───────────────────────────────────────────────────────

function summarise(stdout: string, intent: string): string {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return `(no output) — ${intent}`;
  const preview = lines.slice(0, 5).join(" | ");
  const truncated =
    preview.length > SUMMARY_MAX_CHARS
      ? preview.slice(0, SUMMARY_MAX_CHARS) + "…"
      : preview;
  return `${lines.length} line(s): ${truncated}`;
}

// ─── Workers execution (via Durable Object) ───────────────────────────────────

async function execWorkers(
  env: Env,
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<ExecResult> {
  const id = env.EXECUTOR_DO.newUniqueId();
  const stub = env.EXECUTOR_DO.get(id);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await stub.fetch("https://do-executor/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: binary, args, timeout_ms: timeoutMs }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = (await res.json()) as {
      stdout: string;
      exit_code: number;
      timed_out: boolean;
      error?: string;
    };
    return {
      stdout: data.error ?? data.stdout,
      exit_code: data.exit_code,
      timed_out: data.timed_out,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      stdout: "",
      exit_code: 124,
      timed_out: err instanceof Error && err.name === "AbortError",
    };
  }
}

// ─── ctx_execute ─────────────────────────────────────────────────────────────

export async function ctxExecute(
  env: Env,
  input: ExecuteInput,
  localExecFn?: LocalExecFn   // injected by local.ts; undefined on Workers
): Promise<ExecuteResult | { error: string }> {
  const { command, intent, session_id = "default", actor = "agent" } = input;
  const timeoutMs = Math.min(
    input.timeout ?? DEFAULT_TIMEOUT_MS,
    parseInt(env.MAX_EXEC_TIMEOUT_MS, 10)
  );

  const { binary, args } = parseCommand(command);
  const validationError = validateCommand(binary, args);
  if (validationError) return { error: validationError };

  let result: ExecResult;
  if (localExecFn) {
    result = await localExecFn(binary, args, timeoutMs);
  } else {
    result = await execWorkers(env, binary, args, timeoutMs);
  }

  const { stdout, exit_code, timed_out } = result;

  let summary: string;
  if (timed_out) {
    summary = `(timeout after ${timeoutMs}ms) — ${intent}`;
  } else if (exit_code !== 0) {
    summary = `(exit ${exit_code}) — ${intent}: ${stdout.slice(0, 100)}`;
  } else {
    summary = summarise(stdout, intent);
  }

  const ref_id = await indexToolOutput(env, {
    session_id,
    actor,
    type: "tool_output",
    intent,
    summary,
    raw_size: new TextEncoder().encode(stdout).length,
  });

  return { ref: `[ctx:${ref_id}]`, summary };
}
