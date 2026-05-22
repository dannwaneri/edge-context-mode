// ─── Environment bindings (Cloudflare Workers) ──────────────────────────────

export interface Env {
  DB: D1Database;
  EXECUTOR_DO: DurableObjectNamespace;
  ENVIRONMENT: string;
  DEFAULT_TTL_MS: string;
  MAX_EXEC_TIMEOUT_MS: string;
  // Secrets — set via: wrangler secret put <NAME>
  MCP_SECRET?: string | undefined;
  VECTORIZE_MCP_URL?: string | undefined;
  VECTORIZE_MCP_TOKEN?: string | undefined;
}

// ─── Context entry (stored in D1) ────────────────────────────────────────────

export type EntryType = "tool_output" | "prompt" | "decision" | "event" | "annotation";

export interface ContextEntry {
  id: string;               // [ctx:abc123] token (without brackets)
  session_id: string;
  actor: string;            // human attribution
  type: EntryType;
  intent: string | null;
  summary: string;          // the only text that enters LLM context
  raw_size: number;         // bytes of original output
  raw_output: string | null; // full stdout or annotation text (stored in D1, never auto-sent to LLM)
  vector_id: string | null;
  created_at: number;       // Unix ms
  expires_at: number;       // Unix ms
}

export interface SessionRecord {
  id: string;
  actor: string;
  created_at: number;
  last_seen: number;
}

// ─── Tool inputs / outputs ────────────────────────────────────────────────────

export interface ExecuteInput {
  command: string;
  intent: string;
  session_id?: string;
  actor?: string;
  timeout?: number;    // ms, capped at MAX_EXEC_TIMEOUT_MS
}

export interface ExecuteResult {
  ref: string;         // "[ctx:abc123]"
  summary: string;
}

export interface SearchInput {
  query: string;
  session_id?: string;
  limit?: number;
}

export interface SearchResult {
  ref: string;
  summary: string;
  score: number;
  type: EntryType;
  created_at: number;
}

export interface HistoryInput {
  session_id: string;
  limit?: number;
}

export interface PurgeInput {
  session_id?: string;
  older_than_ms?: number;
}

export interface PurgeResult {
  purged: number;
}

export interface DoctorResult {
  d1: "ok" | "error";
  vectorize_mcp: "ok" | "degraded" | "disabled (optional)";
  execution_mode: "local-stdio" | "workers-http";
  sessions: number;
  entries: number;
  uptime_ms: number;
}

export interface ReflectInput {
  session_id: string;
  prompt?: string;
}

// ─── Store interface ──────────────────────────────────────────────────────────

export interface IndexOptions {
  session_id: string;
  actor: string;
  type: EntryType;
  intent: string;
  summary: string;
  raw_size: number;
  raw_output?: string; // optional: full stdout or annotation body; stored in D1, never returned to LLM automatically
  ttl_ms?: number;
}

// ─── Executor Durable Object RPC ─────────────────────────────────────────────

export interface DOExecRequest {
  command: string;
  args: string[];
  timeout_ms: number;
}

export interface DOExecResponse {
  stdout: string;
  exit_code: number;
  timed_out: boolean;
  error?: string;
}
