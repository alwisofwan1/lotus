import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { ClaudeDirectorRunner, CodexDirectorRunner, type SpawnFn } from "../director-runner.js";
import { ProviderUnavailableError } from "../../agent/errors.js";

const INIT_RESULT = [
  '{"type":"system","subtype":"init","session_id":"dir-1"}',
  '{"type":"result","subtype":"success","session_id":"dir-1","result":"dispatched","is_error":false}',
].join("\n");

interface SpawnOpts { stdout?: string; stderr?: string; exitCode?: number; neverClose?: boolean }

function spawnFactory(opts: SpawnOpts = {}): {
  fn: SpawnFn;
  calls: string[][];
  options: Array<{ stdio?: unknown }>;
  kill: ReturnType<typeof vi.fn>;
} {
  const calls: string[][] = [];
  const options: Array<{ stdio?: unknown }> = [];
  const kill = vi.fn();
  const fn = ((_file: string, args: string[], o: { stdio?: unknown }) => {
    calls.push(args);
    options.push(o);
    const proc = new EventEmitter() as ChildProcess;
    const out = new EventEmitter();
    const err = new EventEmitter();
    Object.assign(proc, { stdout: out, stderr: err, kill });
    setTimeout(() => {
      if (opts.stdout) out.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) err.emit("data", Buffer.from(opts.stderr));
      if (!opts.neverClose) proc.emit("close", opts.exitCode ?? 0);
    }, 0);
    return proc;
  }) as unknown as SpawnFn;
  return { fn, calls, options, kill };
}

function spawnReturning(stdout: string): { fn: SpawnFn; calls: string[][] } {
  const { fn, calls } = spawnFactory({ stdout });
  return { fn, calls };
}

const MCP = '{"mcpServers":{"lotus":{"type":"stdio","command":"bun","args":["sidecar.mjs"]}}}';
const PROMPT = "You are the Headless Director.";

describe("ClaudeDirectorRunner", () => {
  it("loads the lotus MCP config strictly and appends the orchestrator prompt", async () => {
    const { fn, calls } = spawnReturning(INIT_RESULT);
    const runner = new ClaudeDirectorRunner(MCP, PROMPT, fn);
    await runner.invoke({ event: "goal: ship", sessionId: "abc", cwd: "/w", resume: false });
    const args = calls[0]!;
    expect(args).toEqual(expect.arrayContaining(["--mcp-config", MCP, "--strict-mcp-config"]));
    expect(args).toEqual(expect.arrayContaining(["--append-system-prompt", PROMPT]));
    expect(args).toEqual(expect.arrayContaining(["--print", "--output-format", "stream-json"]));
    expect(args[args.length - 1]).toBe("goal: ship"); // prompt is the trailing positional
  });

  it("forces the session id on the first turn and resumes it afterwards", async () => {
    const { fn, calls } = spawnReturning(INIT_RESULT);
    const runner = new ClaudeDirectorRunner(MCP, PROMPT, fn);
    await runner.invoke({ event: "e1", sessionId: "sess-uuid", cwd: "/w", resume: false });
    await runner.invoke({ event: "e2", sessionId: "sess-uuid", cwd: "/w", resume: true });
    expect(calls[0]).toEqual(expect.arrayContaining(["--session-id", "sess-uuid"]));
    expect(calls[0]).not.toContain("--resume");
    expect(calls[1]).toEqual(expect.arrayContaining(["--resume", "sess-uuid"]));
    expect(calls[1]).not.toContain("--session-id");
  });

  it("returns the parsed session id, text, and error flag", async () => {
    const { fn } = spawnReturning(INIT_RESULT);
    const runner = new ClaudeDirectorRunner(MCP, PROMPT, fn);
    const r = await runner.invoke({ event: "e", sessionId: "x", cwd: "/w", resume: false });
    expect(r).toEqual({ sessionId: "dir-1", text: "dispatched", isError: false });
  });

  it("throws ProviderUnavailableError when claude is not installed", async () => {
    const fn = ((file: string, args: string[]) => {
      void file;
      void args;
      const proc = new EventEmitter() as ChildProcess;
      Object.assign(proc, { stdout: new EventEmitter(), stderr: new EventEmitter() });
      setTimeout(() => proc.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })), 0);
      return proc;
    }) as unknown as SpawnFn;
    const runner = new ClaudeDirectorRunner(MCP, PROMPT, fn);
    await expect(runner.invoke({ event: "e", sessionId: "x", cwd: "/w", resume: false }))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

const CODEX_MCP = { sidecarCommand: "bun", sidecarPath: "/app/mcp/lotus-mcp-server.mjs", discoveryPath: "/d/ipc.json" };
const CODEX_OK = [
  '{"type":"thread.started","thread_id":"thread-xyz"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"on it"}}',
].join("\n");

describe("CodexDirectorRunner", () => {
  it("injects the lotus MCP server via -c overrides and bypass/skip-git flags, prepending the prompt on turn one", async () => {
    const { fn, calls } = spawnReturning(CODEX_OK);
    const runner = new CodexDirectorRunner(PROMPT, CODEX_MCP, fn);
    await runner.invoke({ event: "goal: ship", sessionId: "ignored-uuid", cwd: "/w", resume: false });
    const args = calls[0]!;
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("resume"); // first turn — codex mints its own id
    expect(args).toEqual(expect.arrayContaining(["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"]));
    expect(args).toContain('mcp_servers.lotus.command="bun"');
    expect(args).toContain('mcp_servers.lotus.args=["/app/mcp/lotus-mcp-server.mjs","--discovery","/d/ipc.json"]');
    expect(args[args.length - 1]).toBe(`${PROMPT}\n\ngoal: ship`); // system prompt prepended
  });

  it("resumes by codex thread id and does not re-prepend the prompt", async () => {
    const { fn, calls } = spawnReturning(CODEX_OK);
    const runner = new CodexDirectorRunner(PROMPT, CODEX_MCP, fn);
    await runner.invoke({ event: "next step", sessionId: "thread-xyz", cwd: "/w", resume: true });
    const args = calls[0]!;
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "thread-xyz"]);
    expect(args[args.length - 1]).toBe("next step"); // no prepend on resume
  });

  it("returns the parsed codex thread id and agent message", async () => {
    const { fn } = spawnReturning(CODEX_OK);
    const runner = new CodexDirectorRunner(PROMPT, CODEX_MCP, fn);
    const r = await runner.invoke({ event: "e", sessionId: "uuid", cwd: "/w", resume: false });
    expect(r).toEqual({ sessionId: "thread-xyz", text: "on it", isError: false });
  });

  it("surfaces stderr instead of an empty reply when codex dies after thread.started (parity with bridge)", async () => {
    const stdout = '{"type":"thread.started","thread_id":"t-die"}';
    const { fn } = spawnFactory({ stdout, stderr: "Error: sandbox denied", exitCode: 1 });
    const runner = new CodexDirectorRunner(PROMPT, CODEX_MCP, fn);
    const r = await runner.invoke({ event: "e", sessionId: "uuid", cwd: "/w", resume: false });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("sandbox denied");
    expect(r.sessionId).toBe("t-die");
  });
});

// ─── stdin close (1a) + turn timeout (1b) ───────────────────────────────────────

describe("Director runProcess hardening", () => {
  it("closes stdin so codex exec does not hang reading stdin (1a)", async () => {
    const { fn, options } = spawnFactory({ stdout: CODEX_OK });
    const runner = new CodexDirectorRunner(PROMPT, CODEX_MCP, fn);
    await runner.invoke({ event: "e", sessionId: "uuid", cwd: "/w", resume: false });
    expect(options[0]!.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("kills a hung Director process and rejects after the timeout (1b)", async () => {
    const { fn, kill } = spawnFactory({ neverClose: true });
    // Tiny timeout injected via the constructor — no 30-minute wait in tests.
    const runner = new ClaudeDirectorRunner(MCP, PROMPT, fn, process.env, 5);
    await expect(runner.invoke({ event: "e", sessionId: "x", cwd: "/w", resume: false }))
      .rejects.toThrow(/timeout/);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not kill a process that finishes before the timeout", async () => {
    const { fn, kill } = spawnFactory({ stdout: INIT_RESULT });
    const runner = new ClaudeDirectorRunner(MCP, PROMPT, fn, process.env, 10_000);
    await runner.invoke({ event: "e", sessionId: "x", cwd: "/w", resume: false });
    expect(kill).not.toHaveBeenCalled();
  });
});
