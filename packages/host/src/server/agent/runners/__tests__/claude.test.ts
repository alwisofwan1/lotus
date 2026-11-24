import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { ClaudeRunner, permissionFlags } from "../claude.js";
import { ProviderUnavailableError } from "../../errors.js";
import type { PtyManager } from "../../../pty/manager.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeMockPtyManager(): PtyManager {
  return { write: vi.fn() } as unknown as PtyManager;
}

type SpawnFn = ConstructorParameters<typeof ClaudeRunner>[1];

/** Returns a fake ChildProcess and a trigger() that fires stdout data then close. */
function makeProc(stdout: string, exitCode = 0): { proc: ChildProcess; trigger(): void } {
  const out = new EventEmitter();
  const err = new EventEmitter();
  const proc = new EventEmitter() as ChildProcess;
  Object.assign(proc, { stdout: out, stderr: err });

  return {
    proc,
    trigger() {
      if (stdout) out.emit("data", Buffer.from(stdout));
      proc.emit("close", exitCode);
    },
  };
}

/** Makes a spawn fn that returns the given proc and schedules trigger() async. */
function makeSpawnFn(stdout: string, exitCode = 0): SpawnFn {
  const { proc, trigger } = makeProc(stdout, exitCode);
  setTimeout(trigger, 0);
  return () => proc;
}

/** Spawn fn that yields a different stdout per invocation (for retry tests). */
function makeQueuedSpawnFn(outputs: string[]): { fn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const fn = vi.fn((_file: string, args: string[]) => {
    calls.push(args);
    const { proc, trigger } = makeProc(outputs[Math.min(i, outputs.length - 1)] ?? "");
    i += 1;
    setTimeout(trigger, 0);
    return proc;
  }) as unknown as SpawnFn;
  return { fn, calls };
}

const STALE_RESUME_OUTPUT = [
  '{"type":"result","subtype":"error_during_execution","session_id":"dead-id","is_error":true,"errors":["No conversation found with session ID: dead-id"]}',
].join("\n");

const SUCCESS_OUTPUT = [
  '{"type":"system","subtype":"init","session_id":"sess-1"}',
  '{"type":"result","subtype":"success","session_id":"sess-1","result":"Hello!","is_error":false}',
].join("\n");

// ─── chat() ───────────────────────────────────────────────────────────────────

describe("ClaudeRunner.chat()", () => {
  it("returns parsed text and sessionId on success", async () => {
    const runner = new ClaudeRunner(makeMockPtyManager(), makeSpawnFn(SUCCESS_OUTPUT));
    const result = await runner.chat({ prompt: "hi", cwd: "/tmp", provider: "claude", sessionId: null });
    expect(result.text).toBe("Hello!");
    expect(result.sessionId).toBe("sess-1");
    expect(result.isError).toBe(false);
    expect(result.provider).toBe("claude");
  });

  it("passes --print --output-format stream-json and the prompt to claude", async () => {
    const { proc, trigger } = makeProc(SUCCESS_OUTPUT);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new ClaudeRunner(makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "my prompt", cwd: "/workspace", provider: "claude", sessionId: null });
    expect(spawnFn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--print", "--output-format", "stream-json", "my prompt"]),
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("passes --model <alias> when a model is provided, and omits it otherwise", async () => {
    const { proc, trigger } = makeProc(SUCCESS_OUTPUT);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new ClaudeRunner(makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "hi", cwd: "/w", provider: "claude", sessionId: null, model: "sonnet" });
    const withModel = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    expect(withModel).toEqual(expect.arrayContaining(["--model", "sonnet"]));
    expect(withModel.indexOf("--model")).toBeLessThan(withModel.indexOf("hi")); // before the prompt

    const { proc: proc2, trigger: trigger2 } = makeProc(SUCCESS_OUTPUT);
    const spawnFn2 = vi.fn(() => { setTimeout(trigger2, 0); return proc2; }) as unknown as SpawnFn;
    const runner2 = new ClaudeRunner(makeMockPtyManager(), spawnFn2);
    await runner2.chat({ prompt: "hi", cwd: "/w", provider: "claude", sessionId: null });
    const noModel = (spawnFn2 as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    expect(noModel).not.toContain("--model");
  });

  it("appends --resume <sessionId> when sessionId is provided", async () => {
    const { proc, trigger } = makeProc(SUCCESS_OUTPUT);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new ClaudeRunner(makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "follow-up", cwd: "/tmp", provider: "claude", sessionId: "prev-sess" });
    expect(spawnFn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--resume", "prev-sess"]),
      expect.anything(),
    );
  });

  it("does NOT pass --resume when sessionId is null", async () => {
    const { proc, trigger } = makeProc(SUCCESS_OUTPUT);
    const mockFn = vi.fn(() => { setTimeout(trigger, 0); return proc; });
    const runner = new ClaudeRunner(makeMockPtyManager(), mockFn as unknown as SpawnFn);
    await runner.chat({ prompt: "new", cwd: "/tmp", provider: "claude", sessionId: null });
    const args = (mockFn.mock.calls[0] as unknown as [string, string[], unknown])[1];
    expect(args).not.toContain("--resume");
  });

  it("spawns claude with stdin ignored so it does not wait on stdin", async () => {
    const { proc, trigger } = makeProc(SUCCESS_OUTPUT);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new ClaudeRunner(makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "hi", cwd: "/tmp", provider: "claude", sessionId: null });
    const opts = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { stdio?: unknown };
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("returns isError=true when the result line has is_error=true", async () => {
    const errorOutput = [
      '{"type":"system","subtype":"init","session_id":"s2"}',
      '{"type":"result","subtype":"error_during_execution","session_id":"s2","result":"Tool failed","is_error":true}',
    ].join("\n");
    const runner = new ClaudeRunner(makeMockPtyManager(), makeSpawnFn(errorOutput));
    const result = await runner.chat({ prompt: "boom", cwd: "/tmp", provider: "claude", sessionId: null });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Tool failed");
  });

  it("retries once WITHOUT --resume when a stale session id fails to resume", async () => {
    const { fn, calls } = makeQueuedSpawnFn([STALE_RESUME_OUTPUT, SUCCESS_OUTPUT]);
    const runner = new ClaudeRunner(makeMockPtyManager(), fn);
    const result = await runner.chat({ prompt: "hi", cwd: "/tmp", provider: "claude", sessionId: "dead-id" });
    // Recovered on the retry: fresh session, real answer, not an error.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.arrayContaining(["--resume", "dead-id"]));
    expect(calls[1]).not.toContain("--resume");
    expect(result.isError).toBe(false);
    expect(result.text).toBe("Hello!");
    expect(result.sessionId).toBe("sess-1");
  });

  it("does NOT retry on a non-resume error", async () => {
    const errorOutput = [
      '{"type":"result","subtype":"error_during_execution","session_id":"s2","result":"Tool failed","is_error":true}',
    ].join("\n");
    const { fn, calls } = makeQueuedSpawnFn([errorOutput, SUCCESS_OUTPUT]);
    const runner = new ClaudeRunner(makeMockPtyManager(), fn);
    const result = await runner.chat({ prompt: "boom", cwd: "/tmp", provider: "claude", sessionId: "live-id" });
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(true);
  });

  it("does NOT retry a stale-session error when no sessionId was provided", async () => {
    const { fn, calls } = makeQueuedSpawnFn([STALE_RESUME_OUTPUT, SUCCESS_OUTPUT]);
    const runner = new ClaudeRunner(makeMockPtyManager(), fn);
    const result = await runner.chat({ prompt: "hi", cwd: "/tmp", provider: "claude", sessionId: null });
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(true);
  });

  it("kills the child process and rejects when the abort signal fires", async () => {
    const proc = new EventEmitter() as ChildProcess;
    const kill = vi.fn();
    Object.assign(proc, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill });
    const spawnFn = vi.fn(() => proc) as unknown as SpawnFn; // never emits "close" → hangs
    const ctrl = new AbortController();
    const runner = new ClaudeRunner(makeMockPtyManager(), spawnFn);
    const p = runner.chat({ prompt: "hi", cwd: "/tmp", provider: "claude", sessionId: null, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow();
    expect(kill).toHaveBeenCalled();
  });

  it("throws ProviderUnavailableError when claude binary is not found", async () => {
    const proc = new EventEmitter() as ChildProcess;
    const out = new EventEmitter();
    const err = new EventEmitter();
    Object.assign(proc, { stdout: out, stderr: err });
    const spawnFn = vi.fn(() => {
      setTimeout(() => proc.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })), 0);
      return proc;
    }) as unknown as SpawnFn;
    const runner = new ClaudeRunner(makeMockPtyManager(), spawnFn);
    await expect(runner.chat({ prompt: "hi", cwd: "/tmp", provider: "claude", sessionId: null }))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

// ─── spawnPty() ───────────────────────────────────────────────────────────────

describe("ClaudeRunner.spawnPty()", () => {
  /**
   * `--dangerously-skip-permissions` was unconditional here until 2026-09-05, which is the
   * trap `issues/03` found before Phase 2 was written: the phone advertises a posture
   * scale (`CLAUDE_PERMISSIONS`), and a cell launched with the gate off regardless would
   * have shown an operator a permission knob the machine ignores. ADR-8 makes that
   * unfixable once the cell is running.
   *
   * No mode means claude's own default, which is `manual` — so no flag, and it asks.
   */
  it("adds no permission flag when no mode was chosen, so claude asks as it always does", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude" }, "pty-session-1");
    expect(pty.write).toHaveBeenCalledWith("pty-session-1", "claude\n");
  });

  /**
   * `spawn-tuning` reaches the argv, or it is a picker the machine ignores.
   *
   * Flags probed against the installed CLI on 2026-09-10 rather than taken from a doc:
   * `claude --help` lists `--model <model>` and `--effort <level> (low, medium, high,
   * xhigh, max)` — the second matching `CLAUDE_EFFORTS` exactly. Issue 22 of
   * `plans/pocket-without-laptop`.
   */
  it("writes the chosen model as --model", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude", model: "opus" }, "p1");
    expect(pty.write).toHaveBeenCalledWith("p1", "claude --model opus\n");
  });

  it("runs on the chosen account, and unsets the variable for default (issues/07)", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn, { CLAUDE_CONFIG_DIR: "/elsewhere" });
    await runner.spawnPty({ cwd: "/tmp", provider: "claude", configDir: "/h/accounts/hss" }, "p1");
    expect(pty.write).toHaveBeenCalledWith("p1", "CLAUDE_CONFIG_DIR=/h/accounts/hss claude\n");
    await runner.spawnPty({ cwd: "/tmp", provider: "claude", configDir: null }, "p2");
    expect(pty.write).toHaveBeenCalledWith("p2", "env -u CLAUDE_CONFIG_DIR claude\n");
  });

  it("writes the chosen effort as --effort", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude", effort: "xhigh" }, "p1");
    expect(pty.write).toHaveBeenCalledWith("p1", "claude --effort xhigh\n");
  });

  it("keeps posture, model and effort together on one line", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty(
      { cwd: "/tmp", provider: "claude", permissionMode: "acceptEdits", model: "opus", effort: "max" },
      "p1",
    );
    expect(pty.write).toHaveBeenCalledWith(
      "p1", "claude --permission-mode acceptEdits --model opus --effort max\n");
  });

  it("a model with a space cannot break the line into two arguments", async () => {
    // The command is *typed into a PTY*, so the shell splits it. An alias the operator
    // pasted with a space would otherwise become a second argv entry and claude would
    // read it as a path.
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude", model: "not an alias" }, "p1");
    const line = (pty.write as unknown as { mock: { calls: string[][] } }).mock.calls[0]![1];
    expect(line).toBe("claude --model 'not an alias'\n");
  });

  it("passes a chosen mode through as --permission-mode", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude", permissionMode: "acceptEdits" }, "p1");
    expect(pty.write).toHaveBeenCalledWith("p1", "claude --permission-mode acceptEdits\n");
  });

  it("turns the gate off only when asked to, by either name for it", async () => {
    for (const mode of ["bypassPermissions", "yolo"]) {
      const pty = makeMockPtyManager();
      const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
      await runner.spawnPty({ cwd: "/tmp", provider: "claude", permissionMode: mode }, "p2");
      expect(pty.write).toHaveBeenCalledWith("p2", "claude --dangerously-skip-permissions\n");
    }
  });

  /**
   * `safe` is the phone's word for `manual`, and it is PASSED rather than assumed. Leaving it
   * implicit was measured wrong on 2026-09-06: a cell spawned "as manual" came up in auto mode,
   * because the effective mode can come from state this host cannot see.
   */
  it("passes the phone's word for the safe end as an explicit mode", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude", permissionMode: "safe" }, "p3");
    expect(pty.write).toHaveBeenCalledWith("p3", "claude --permission-mode manual\n");
  });

  it("passes manual explicitly too, rather than trusting a default", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude", permissionMode: "manual" }, "p4");
    expect(pty.write).toHaveBeenCalledWith("p4", "claude --permission-mode manual\n");
  });

  /**
   * The command is written now; the prompt is typed once the TUI has taken the terminal, as text
   * and then Enter (`agent/tui-prompt.ts`). Both halves were measured on 2026-09-07 — written
   * straight after the command line, the prompt sat in the input box unsent.
   */
  it("types the initial prompt only after the TUI has taken the terminal", async () => {
    const tails = ["", "\u001b[?1049h\u001b[?2004h"];
    let reads = 0;
    const pty = {
      write: vi.fn(),
      getSession: () => ({ getBufferTail: () => tails[Math.min(reads++, tails.length - 1)] ?? "" }),
    } as unknown as PtyManager;
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude", prompt: "do the thing" }, "pty-42");

    const calls = (): unknown[][] => (pty.write as ReturnType<typeof vi.fn>).mock.calls;
    // The spawn answers before the prompt is typed: waiting for a TUI would hold the caller.
    expect(calls()).toEqual([["pty-42", "claude\n"]]);
    await vi.waitFor(() => expect(calls()).toHaveLength(3));
    expect(calls()[1]).toEqual(["pty-42", "do the thing"]);
    expect(calls()[2]).toEqual(["pty-42", "\r"]);
  });

  it("does not write a second time when no prompt is provided", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude" }, "pty-99");
    expect((pty.write as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

// ─── Remote-Scoped Skills (ADR-0018) ────────────────────────────────────────

const MOUNT = "/home/op/.lotus-remote/agent-mount";
const TEST_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test" };

describe("ClaudeRunner remote-scoped skills", () => {
  it("chat() injects --add-dir <mount> before the prompt when remoteScoped", async () => {
    const { proc, trigger } = makeProc(SUCCESS_OUTPUT);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new ClaudeRunner(makeMockPtyManager(), spawnFn, TEST_ENV, MOUNT);
    await runner.chat({ prompt: "go", cwd: "/w", provider: "claude", sessionId: null, remoteScoped: true });
    const args = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(["--add-dir", MOUNT]));
    // Prompt MUST precede --add-dir (variadic) or claude eats the prompt as a dir.
    expect(args.indexOf("go")).toBeLessThan(args.indexOf("--add-dir"));
  });

  it("chat() omits --add-dir when remoteScoped is not set", async () => {
    const { proc, trigger } = makeProc(SUCCESS_OUTPUT);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new ClaudeRunner(makeMockPtyManager(), spawnFn, TEST_ENV, MOUNT);
    await runner.chat({ prompt: "go", cwd: "/w", provider: "claude", sessionId: null });
    const args = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    expect(args).not.toContain("--add-dir");
  });

  it("spawnPty() includes --add-dir <mount> in the command when remoteScoped", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn, TEST_ENV, MOUNT);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude", remoteScoped: true }, "pty-rs");
    // The mount rides alongside whatever the posture asked for — here nothing, since no
    // mode was chosen and claude's default asks (see `spawnPty()` above).
    expect(pty.write).toHaveBeenCalledWith("pty-rs", `claude --add-dir ${MOUNT}\n`);
  });

  it("spawnPty() command is unchanged when not remoteScoped", async () => {
    const pty = makeMockPtyManager();
    const runner = new ClaudeRunner(pty, vi.fn() as unknown as SpawnFn, TEST_ENV, MOUNT);
    await runner.spawnPty({ cwd: "/tmp", provider: "claude" }, "pty-plain");
    expect(pty.write).toHaveBeenCalledWith("pty-plain", "claude\n");
  });
});

// ─── Lotus agent persona ─────────────────────────────────────────────────────

describe("ClaudeRunner persona", () => {
  it("appends the Lotus agent persona (default) before the prompt", async () => {
    const { proc, trigger } = makeProc(SUCCESS_OUTPUT);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new ClaudeRunner(makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "go", cwd: "/w", provider: "claude", sessionId: null });
    const args = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    const i = args.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toContain("Lotus Remote Agent");
    expect(i).toBeLessThan(args.indexOf("go")); // persona precedes the prompt
  });

  it("omits --append-system-prompt when the persona is empty", async () => {
    const { proc, trigger } = makeProc(SUCCESS_OUTPUT);
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new ClaudeRunner(makeMockPtyManager(), spawnFn, TEST_ENV, MOUNT, "");
    await runner.chat({ prompt: "go", cwd: "/w", provider: "claude", sessionId: null });
    const args = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    expect(args).not.toContain("--append-system-prompt");
  });
});

describe("permission mode shell safety", () => {
  it.each([
    "manual; printf INJECTED",
    "$(printf INJECTED)",
    "`printf INJECTED`",
    "mode'with quote",
    "manual\nprintf INJECTED",
    "",
  ])("passes %j as exactly one literal argument", (mode) => {
    // Use a shell function instead of launching Claude; exercise the same PTY command join.
    const command = `claude() { printf '%s\\n' "$@"; }; claude ${permissionFlags(mode).join(" ")}`;
    const output = execFileSync("sh", ["-c", command], { encoding: "utf8" });
    expect(output).toBe(`--permission-mode\n${mode}\n`);
  });
});
