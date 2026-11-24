import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CcsRunner } from "../ccs.js";
import { permissionFlags } from "../claude.js";
import { ProviderUnavailableError } from "../../errors.js";
import type { PtyManager } from "../../../pty/manager.js";

type SpawnFn = ConstructorParameters<typeof CcsRunner>[2];

function makeMockPtyManager(): PtyManager {
  return { write: vi.fn() } as unknown as PtyManager;
}

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

function makeSpawnFn(stdout: string, exitCode = 0): SpawnFn {
  const { proc, trigger } = makeProc(stdout, exitCode);
  setTimeout(trigger, 0);
  return () => proc;
}

// ─── providerId ───────────────────────────────────────────────────────────────

describe("CcsRunner.providerId", () => {
  it("is 'ccs:<account>'", () => {
    const runner = new CcsRunner("initech", makeMockPtyManager(), vi.fn() as unknown as SpawnFn);
    expect(runner.providerId).toBe("ccs:initech");
  });
});

// ─── chat() ───────────────────────────────────────────────────────────────────

describe("CcsRunner.chat()", () => {
  it("returns stdout text as the response for a new conversation", async () => {
    const runner = new CcsRunner("work", makeMockPtyManager(), makeSpawnFn("Here is my response\n"));
    const result = await runner.chat({ prompt: "hello", cwd: "/srv", provider: "ccs:work", sessionId: null });
    expect(result.text).toBe("Here is my response");
    expect(result.isError).toBe(false);
    expect(result.provider).toBe("ccs:work");
  });

  it("ignores remoteScoped — ccs flag forwarding is unverified (ADR-0018 no-op)", async () => {
    const { proc, trigger } = makeProc("ok");
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new CcsRunner("work", makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "go", cwd: "/srv", provider: "ccs:work", sessionId: null, remoteScoped: true });
    const args = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    expect(args).not.toContain("--add-dir");
  });

  it("calls 'ccs <account> -p <prompt>' for new conversation", async () => {
    const { proc, trigger } = makeProc("ok");
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new CcsRunner("initech", makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "do stuff", cwd: "/srv", provider: "ccs:initech", sessionId: null });
    expect(spawnFn).toHaveBeenCalledWith(
      "ccs",
      expect.arrayContaining(["initech", "-p", "do stuff"]),
      expect.objectContaining({ cwd: "/srv" }),
    );
  });

  it("calls 'ccs <account>:continue -p <prompt>' when sessionId is present", async () => {
    const { proc, trigger } = makeProc("continued");
    const spawnFn = vi.fn(() => { setTimeout(trigger, 0); return proc; }) as unknown as SpawnFn;
    const runner = new CcsRunner("work", makeMockPtyManager(), spawnFn);
    await runner.chat({ prompt: "follow up", cwd: "/srv", provider: "ccs:work", sessionId: "prev-id" });
    expect(spawnFn).toHaveBeenCalledWith(
      "ccs",
      expect.arrayContaining(["work:continue", "-p", "follow up"]),
      expect.anything(),
    );
  });

  it("returns isError=true when the process exits non-zero", async () => {
    const runner = new CcsRunner("work", makeMockPtyManager(), makeSpawnFn("fail", 1));
    const result = await runner.chat({ prompt: "boom", cwd: "/tmp", provider: "ccs:work", sessionId: null });
    expect(result.isError).toBe(true);
  });

  it("throws ProviderUnavailableError when ccs binary is not found", async () => {
    const proc = new EventEmitter() as ChildProcess;
    Object.assign(proc, { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const spawnFn = vi.fn(() => {
      setTimeout(() => proc.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })), 0);
      return proc;
    }) as unknown as SpawnFn;
    const runner = new CcsRunner("work", makeMockPtyManager(), spawnFn);
    await expect(runner.chat({ prompt: "hi", cwd: "/tmp", provider: "ccs:work", sessionId: null }))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

// ─── spawnPty() ───────────────────────────────────────────────────────────────

describe("CcsRunner.spawnPty()", () => {
  it("writes 'ccs <account>' to the PTY session", async () => {
    const pty = makeMockPtyManager();
    const runner = new CcsRunner("initech", pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "ccs:initech" }, "pty-1");
    expect(pty.write).toHaveBeenCalledWith("pty-1", "ccs initech\n");
  });

  /**
   * `ccs --help` (v8.7.0, probed 2026-09-10) reads `ccs <profile> [claude-args...]`, so the
   * wrapper forwards claude's own flags — the same `--model`/`--effort` a native claude cell
   * takes. Issue 22 of `plans/pocket-without-laptop`.
   */
  it("forwards the chosen model and effort as claude-args", async () => {
    const pty = makeMockPtyManager();
    const runner = new CcsRunner("initech", pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty(
      { cwd: "/tmp", provider: "ccs:initech", model: "opus", effort: "max" }, "pty-1");
    expect(pty.write).toHaveBeenCalledWith("pty-1", "ccs initech --model opus --effort max\n");
  });

  /// What is launched must be what the fleet claims (ADR-8).
  ///
  /// `ccs.ts` wrote `ccs <account>` and nothing else, so the posture the operator picked never
  /// reached the CLI — while `server/routes/fleet.ts:199` reported one anyway:
  /// `runnerFamily("ccs:x")` gives `provider: "claude"`, so `gatingFor` answered `asks` or
  /// `skipped` from the mode stored at spawn. Pick `yolo` and the phone was shown a gate that
  /// was off on a cell that still asked, then the cell sat at a prompt the phone believed
  /// could not happen. Issue 25 of `plans/pocket-without-laptop`.
  ///
  /// The wrapper takes them: `ccs --help` v8.7.0 reads `ccs <profile> [claude-args...]`.
  it("forwards the posture, so `skipped` on the fleet means the gate really is off", () => {
    // Paired with `gatingFor("claude", "yolo") === "skipped"` in `gating.test.ts`.
    expect(permissionFlags("yolo")).toEqual(["--dangerously-skip-permissions"]);
  });

  it("writes --permission-mode for a posture that still asks", async () => {
    const pty = makeMockPtyManager();
    const runner = new CcsRunner("initech", pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty(
      { cwd: "/tmp", provider: "ccs:initech", permissionMode: "acceptEdits" }, "pty-1");
    expect(pty.write).toHaveBeenCalledWith(
        "pty-1", "ccs initech --permission-mode acceptEdits\n");
  });

  it("turns the gate off when that is what was chosen", async () => {
    const pty = makeMockPtyManager();
    const runner = new CcsRunner("initech", pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty(
      { cwd: "/tmp", provider: "ccs:initech", permissionMode: "yolo" }, "pty-1");
    expect(pty.write).toHaveBeenCalledWith(
        "pty-1", "ccs initech --dangerously-skip-permissions\n");
  });

  it("writes the bare command when nothing was tuned", async () => {
    const pty = makeMockPtyManager();
    const runner = new CcsRunner("initech", pty, vi.fn() as unknown as SpawnFn);
    await runner.spawnPty({ cwd: "/tmp", provider: "ccs:initech" }, "pty-1");
    expect(pty.write).toHaveBeenCalledWith("pty-1", "ccs initech\n");
  });
});
