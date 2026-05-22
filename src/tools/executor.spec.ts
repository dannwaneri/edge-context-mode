import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./store", () => ({
  indexToolOutput: vi.fn(() => Promise.resolve("abc123")),
}));

import { ctxExecute } from "./executor";

const dummyEnv = { MAX_EXEC_TIMEOUT_MS: "10000" } as any;

const localExecFn = async (binary: string, args: string[], timeoutMs: number) => {
  return { stdout: "ok\nline2", exit_code: 0, timed_out: false };
};

describe("validateCommand via ctxExecute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows whitelisted command 'node'", async () => {
    const res = await ctxExecute(
      dummyEnv,
      { command: "node -v", intent: "test", session_id: "s1" },
      localExecFn
    );
    expect(res).toHaveProperty("ref");
    expect((res as any).summary).toBeDefined();
    expect((res as any).summary).toContain("line(s)");
  });

  it("rejects unknown binary 'rm' with COMMAND_NOT_ALLOWED", async () => {
    const res = await ctxExecute(dummyEnv, { command: "rm -rf /", intent: "test" });
    expect(res).toHaveProperty("error");
    expect((res as any).error).toContain("COMMAND_NOT_ALLOWED");
    expect((res as any).error).toContain("rm");
  });

  it("blocks path traversal attempts like '../etc'", async () => {
    const res = await ctxExecute(dummyEnv, { command: "cat ../etc/passwd", intent: "test" });
    expect(res).toHaveProperty("error");
    expect((res as any).error).toContain("path traversal");
  });

  it("rejects git subcommands not in the allowlist", async () => {
    const res = await ctxExecute(dummyEnv, { command: "git rebase", intent: "test" });
    expect(res).toHaveProperty("error");
    expect((res as any).error).toContain("subcommand not permitted");
    expect((res as any).error).toContain("git rebase");
  });
});
