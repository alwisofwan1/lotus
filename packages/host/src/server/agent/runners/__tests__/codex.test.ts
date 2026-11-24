import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CodexRunner, finalizeCodexText } from "../codex.js";
import { ProviderUnavailableError } from "../../errors.js";
import type { PtyManager } from "../../../pty/manager.js";

type SpawnFn = ConstructorParameters<typeof CodexRunner>[1];

function makeMockPtyManager(): PtyManager {
  return { write: vi.fn() } as unknown as PtyManager;
}

function makeProc(stdout: string, exitCode = 0, stderr = ""): { proc: ChildProcess; trigger(): void } {
  const out = new EventEmitter();
  const err = new EventEmitter();
  const proc = new EventEmitter() as ChildProcess;
  Object.assign(proc, { stdout: out, stderr: err });
  return {
    proc,
    trigger() {
      if (stdout) out.emit("data", Buffer.from(stdout));
      if (stderr) err.emit("data", Buffer.from(stderr));
      proc.emit("close", exitCode);
    },
  };
}

function makeSpawnFn(stdout: string, exitCode = 0, stderr = ""): SpawnFn {
  const { proc, trigger } = makeProc(stdout, exitCode, stderr);
  setTimeout(trigger, 0);
  return () => proc;
}

// ─── chat() ───────────────────────────────────────────────────────────────────

const CODEX_OK = [
  '{"type":"thread.started","thread_id":"t-1"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"Hello from codex"}}',
].join("\n");

describe("CodexRunner.chat()", () => {
  it("returns the agent_message text and thread id parsed from codex --json events", async () => {
    const runner = new CodexRunner(makeMockPtyManager(), makeSpawnFn(CODEX_OK));
    const result = await runner.chat({ prompt: "hi", cwd: "/tmp", provider: "codex", sessionId: null });
    expect(result.text).toBe("Hello from codex");
    expect(result.sessionId).toBe("t-1");
    expect(result.provider).toBe("codex");
    expect(result.isError).toBe(false);
  });

  it("invokes `codex exec --json` with headless flags and the prompt (no removed --quiet)", async () => {
    const { proc, trigger } = makeProc(CODEX_OK);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new CodexRunner(makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "my prompt", cwd: "/workspace", provider: "codex", sessionId: null });
    const args = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    expect(args[0]).toBe("exec");
    expect(args).toEqual(expect.arrayContaining(["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "my prompt"]));
    expect(args).not.toContain("--quiet");
  });

  it("spawns codex with stdin ignored so `exec` does not hang reading stdin", async () => {
    const { proc, trigger } = makeProc(CODEX_OK);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new CodexRunner(makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "hi", cwd: "/w", provider: "codex", sessionId: null });
    const opts = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { stdio?: unknown };
    // codex 0.139 `exec` blocks forever on stdin even with a prompt arg unless
    // stdin is closed — ["ignore","pipe","pipe"] lets it proceed immediately.
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("ignores remoteScoped — codex has no --add-dir (ADR-0018 no-op)", async () => {
    const { proc, trigger } = makeProc(CODEX_OK);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new CodexRunner(makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "go", cwd: "/w", provider: "codex", sessionId: null, remoteScoped: true });
    const args = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    expect(args).not.toContain("--add-dir");
  });

  it("returns isError=true when the process exits non-zero", async () => {
    const runner = new CodexRunner(makeMockPtyManager(), makeSpawnFn("", 1));
    const result = await runner.chat({ prompt: "boom", cwd: "/tmp", provider: "codex", sessionId: null });
    expect(result.isError).toBe(true);
  });

  it("surfaces stderr instead of an empty reply when codex fails with only a thread.started event", async () => {
    // codex 0.139 emits thread.started, then dies — stdout parses to empty text
    // but stderr carries the real cause. Without surfacing it the user saw
    // "(empty response)".
    const stdout = '{"type":"thread.started","thread_id":"t-9"}';
    const stderr = "Error: stream disconnected before completion";
    const runner = new CodexRunner(makeMockPtyManager(), makeSpawnFn(stdout, 1, stderr));
    const result = await runner.chat({ prompt: "hi", cwd: "/tmp", provider: "codex", sessionId: null });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("stream disconnected");
  });

  it("resumes by codex thread id via `exec resume <id>` when a sessionId is given", async () => {
    const { proc, trigger } = makeProc(CODEX_OK);
    const mockFn = vi.fn(() => { setTimeout(trigger, 0); return proc; });
    const runner = new CodexRunner(makeMockPtyManager(), mockFn as unknown as SpawnFn);
    await runner.chat({ prompt: "follow-up", cwd: "/tmp", provider: "codex", sessionId: "t-prev" });
    const args = (mockFn.mock.calls[0] as unknown as [string, string[], unknown])[1];
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "t-prev"]);
  });

  it("kills the child process and rejects when the abort signal fires", async () => {
    const proc = new EventEmitter() as ChildProcess;
    const kill = vi.fn();
    Object.assign(proc, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill });
    const spawnFn = vi.fn(() => proc) as unknown as SpawnFn; // never emits "close" → hangs
    const ctrl = new AbortController();
    const runner = new CodexRunner(makeMockPtyManager(), spawnFn);
    const p = runner.chat({ prompt: "hi", cwd: "/tmp", provider: "codex", sessionId: null, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow();
    expect(kill).toHaveBeenCalled();
  });

  it("throws ProviderUnavailableError when codex binary is not found", async () => {
    const proc = new EventEmitter() as ChildProcess;
    Object.assign(proc, { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const spawnFn = vi.fn(() => {
      setTimeout(() => proc.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })), 0);
      return proc;
    }) as unknown as SpawnFn;
    const runner = new CodexRunner(makeMockPtyManager(), spawnFn);
    await expect(runner.chat({ prompt: "hi", cwd: "/tmp", provider: "codex", sessionId: null }))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

// ─── spawnPty() ───────────────────────────────────────────────────────────────

describe("CodexRunner.spawnPty()", () => {
  it("writes 'codex' to the PTY session", async () => {
    const pty = makeMockPtyManager();
    const runner = new CodexRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "codex" }, "pty-abc");
    expect(pty.write).toHaveBeenCalledWith("pty-abc", "codex\n");
  });

  /**
   * Codex has no `--effort`. Probed against the installed CLI on 2026-09-10:
   * `codex --help` lists `-m, --model <MODEL>` and `-c, --config <key=value>`, and the key
   * `model_reasoning_effort` appears 26 times in the 0.154.0 binary's string table — so it
   * is a real config key and not a guess. Issue 23 of `plans/pocket-without-laptop`.
   *
   * The accepted effort **values** are deliberately not asserted here: they were not proven
   * (see the issue), and nothing between the phone and this line judges them anyway.
   */
  it("writes the chosen model as -m", async () => {
    const pty = makeMockPtyManager();
    const runner = new CodexRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "codex", model: "o3" }, "p1");
    expect(pty.write).toHaveBeenCalledWith("p1", "codex -m o3\n");
  });

  it("writes the chosen effort through -c, the only door codex offers", async () => {
    const pty = makeMockPtyManager();
    const runner = new CodexRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "codex", effort: "xhigh" }, "p1");
    expect(pty.write).toHaveBeenCalledWith("p1", "codex -c model_reasoning_effort=xhigh\n");
  });

  it("writes the bare command when nothing was tuned", async () => {
    const pty = makeMockPtyManager();
    const runner = new CodexRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "codex", model: "", effort: "" }, "p1");
    expect(pty.write).toHaveBeenCalledWith("p1", "codex\n");
  });

  it("does not write a second time (codex interactive reads stdin)", async () => {
    const pty = makeMockPtyManager();
    const runner = new CodexRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "codex", prompt: "ignored" }, "pty-xyz");
    expect((pty.write as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

// ─── finalizeCodexText() ───────────────────────────────────────────────────────

describe("finalizeCodexText()", () => {
  it("passes a successful reply through untouched", () => {
    expect(finalizeCodexText("Hello", "", 0, false)).toEqual({ text: "Hello", isError: false });
  });

  it("surfaces stderr when the turn failed with empty parsed text", () => {
    const r = finalizeCodexText("", "Error: not logged in", 1, false);
    expect(r).toEqual({ text: "Error: not logged in", isError: true });
  });

  it("synthesizes a message when both parsed text and stderr are empty", () => {
    const r = finalizeCodexText("", "", 2, false);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("exited with code 2");
  });

  it("keeps parser-extracted error text over stderr", () => {
    const r = finalizeCodexText("model not supported", "noise", 1, true);
    expect(r.text).toBe("model not supported");
  });
});
