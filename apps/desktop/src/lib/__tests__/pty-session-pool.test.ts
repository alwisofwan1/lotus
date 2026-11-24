import { afterEach, describe, expect, it, vi } from "vitest";
import type { PtySessionController } from "../pty-session-controller";
import {
  attachPersistentPty,
  clearPersistentPtyPoolForTests,
  createPersistentPty,
  destroyPersistentPty,
  destroyPersistentPtyConfirmed,
  destroyScopePersistentPtys,
  detachPersistentPty,
  dispatchPersistentPtyOutput,
  getPersistentPtyController,
  getPersistentPtySnapshot,
  getPersistentPtyTranscript,
  hasPersistentPty,
  hasRunnerLaunched,
  markPersistentPtyConnected,
  markRunnerLaunched,
} from "../pty-session-pool";

function fakeController(): { controller: PtySessionController; abort: ReturnType<typeof vi.fn> } {
  const abort = vi.fn();
  const controller = {
    abort,
    write: vi.fn(),
    resize: vi.fn(),
    getSessionId: vi.fn(() => "runtime-1"),
    isAborted: vi.fn(() => abort.mock.calls.length > 0),
  } as unknown as PtySessionController;
  return { controller, abort };
}

describe("pty-session-pool", () => {
  it("retains the entry until kill is acknowledged, including after a failed kill", async () => {
    const { controller } = fakeController();
    let acknowledge!: () => void;
    controller.abortConfirmed = vi.fn().mockRejectedValueOnce(new Error("kill failed"))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    createPersistentPty("confirmed", "canvas:a", controller);
    await expect(destroyPersistentPtyConfirmed("confirmed")).rejects.toThrow("kill failed");
    expect(hasPersistentPty("confirmed")).toBe(true);
    const closing = destroyPersistentPtyConfirmed("confirmed");
    expect(hasPersistentPty("confirmed")).toBe(true);
    acknowledge();
    await closing;
    expect(hasPersistentPty("confirmed")).toBe(false);
  });
  afterEach(() => clearPersistentPtyPoolForTests());

  it("exposes the bounded transcript mirror for voice read-back", () => {
    const { controller: ctrl } = fakeController();
    expect(getPersistentPtyTranscript("agent-1")).toBeNull();

    createPersistentPty("agent-1", "canvas:proj-a", ctrl);
    dispatchPersistentPtyOutput("agent-1", "line one\n");
    dispatchPersistentPtyOutput("agent-1", "line two");

    expect(getPersistentPtyTranscript("agent-1")).toBe("line one\nline two");
    expect(getPersistentPtyTranscript("missing")).toBeNull();
  });

  it("preserves literal session markers embedded in ordinary output", () => {
    const { controller } = fakeController();
    const sink = vi.fn();
    const end = vi.fn();
    createPersistentPty("literal", "canvas:a", controller);
    markPersistentPtyConnected("literal", "shell", "sess-1");
    attachPersistentPty("literal", sink, end);
    const data = "documentation: [Session ended:0]\r\nnext line";
    dispatchPersistentPtyOutput("literal", data);
    expect(end).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledWith(data);
    expect(getPersistentPtyTranscript("literal")).toBe(data);
    expect(getPersistentPtySnapshot("literal")?.status).toBe("connected");
  });

  it("routes live output to the attached sink", () => {
    const { controller: ctrl } = fakeController();
    const sink = vi.fn();
    createPersistentPty("agent-1", "canvas:proj-a", ctrl);
    attachPersistentPty("agent-1", sink, vi.fn());

    dispatchPersistentPtyOutput("agent-1", "hello ");
    dispatchPersistentPtyOutput("agent-1", "world");

    expect(sink.mock.calls.map((c) => c[0]).join("")).toBe("hello world");
  });

  it("keeps the controller alive on detach and replays the transcript on reattach", () => {
    const { controller: ctrl, abort } = fakeController();
    const firstSink = vi.fn();
    createPersistentPty("agent-1", "canvas:proj-a", ctrl);
    attachPersistentPty("agent-1", firstSink, vi.fn());
    dispatchPersistentPtyOutput("agent-1", "line-before-switch\n");

    // Project switch: node unmounts → detach (NOT destroy). Controller stays alive.
    detachPersistentPty("agent-1");
    expect(abort).not.toHaveBeenCalled();
    expect(hasPersistentPty("agent-1")).toBe(true);

    // Output produced while the user is away is still mirrored into the transcript.
    dispatchPersistentPtyOutput("agent-1", "line-while-away\n");
    expect(firstSink).not.toHaveBeenCalledWith("line-while-away\n");

    // Switch back: fresh terminal reattaches and sees the full running transcript.
    const secondSink = vi.fn();
    const result = attachPersistentPty("agent-1", secondSink, vi.fn());
    expect(result).toEqual({ status: "connecting", mode: null, sessionId: null });
    expect(secondSink).toHaveBeenCalledWith("line-before-switch\nline-while-away\n");

    // ...and live output resumes to the new sink.
    dispatchPersistentPtyOutput("agent-1", "line-after-return\n");
    expect(secondSink).toHaveBeenCalledWith("line-after-return\n");
  });

  it("re-arms one-shot terminal modes on reattach even after the transcript overflowed them", () => {
    const { controller: ctrl } = fakeController();
    createPersistentPty("agent-1", "canvas:proj-a", ctrl);
    attachPersistentPty("agent-1", vi.fn(), vi.fn());

    // CLI startup enables bracketed paste ONCE, then a TUI repaint flood pushes it
    // out of the bounded transcript mirror (the paste-auto-submit bug).
    dispatchPersistentPtyOutput("agent-1", "\x1b[?2004h\x1b[?1004hwelcome banner\n");
    dispatchPersistentPtyOutput("agent-1", "x".repeat(300_000));

    detachPersistentPty("agent-1");
    const chunks: string[] = [];
    attachPersistentPty("agent-1", (data) => chunks.push(data), vi.fn());

    const replay = chunks.join("");
    expect(replay).not.toContain("welcome banner"); // sanity: the enable really overflowed
    expect(replay.startsWith("\x1b[?1004h\x1b[?2004h")).toBe(true); // modes re-armed BEFORE the transcript
  });

  it("does not re-arm a mode the CLI disabled before the reattach", () => {
    const { controller: ctrl } = fakeController();
    createPersistentPty("agent-1", "canvas:proj-a", ctrl);
    attachPersistentPty("agent-1", vi.fn(), vi.fn());
    dispatchPersistentPtyOutput("agent-1", "\x1b[?2004h boot ");
    dispatchPersistentPtyOutput("agent-1", "\x1b[?2004l teardown ");
    dispatchPersistentPtyOutput("agent-1", "x".repeat(300_000)); // push both markers out of the mirror

    detachPersistentPty("agent-1");
    const chunks: string[] = [];
    attachPersistentPty("agent-1", (data) => chunks.push(data), vi.fn());

    expect(chunks.join("")).not.toContain("\x1b[?2004h");
  });

  it("reports connected status/mode/sessionId to a reattaching consumer", () => {
    const { controller: ctrl } = fakeController();
    createPersistentPty("agent-1", "canvas:proj-a", ctrl);
    attachPersistentPty("agent-1", vi.fn(), vi.fn());
    markPersistentPtyConnected("agent-1", "command", "sess-123");
    detachPersistentPty("agent-1");

    const result = attachPersistentPty("agent-1", vi.fn(), vi.fn());
    expect(result).toEqual({ status: "connected", mode: "command", sessionId: "sess-123" });
    expect(getPersistentPtySnapshot("agent-1")).toMatchObject({ status: "connected", mode: "command" });
  });

  it("fires the end sink immediately when reattaching a session that ended while detached", () => {
    const { controller: ctrl } = fakeController();
    createPersistentPty("agent-1", "canvas:proj-a", ctrl);
    attachPersistentPty("agent-1", vi.fn(), vi.fn());
    detachPersistentPty("agent-1");
    dispatchPersistentPtyOutput("agent-1", "bye ");
    dispatchPersistentPtyOutput("agent-1", "[Session ended:0]\r\n");

    const endSink = vi.fn();
    attachPersistentPty("agent-1", vi.fn(), endSink);
    expect(endSink).toHaveBeenCalledWith(0);
    expect(getPersistentPtySnapshot("agent-1")).toMatchObject({ status: "ended", ended: true });
  });

  it("destroys a session on explicit close (aborts the controller, drops the entry)", () => {
    const { controller: ctrl, abort } = fakeController();
    createPersistentPty("agent-1", "canvas:proj-a", ctrl);
    destroyPersistentPty("agent-1");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(hasPersistentPty("agent-1")).toBe(false);
    expect(getPersistentPtyController("agent-1")).toBeNull();
  });

  it("tears down only the sessions in a closed project scope", () => {
    const { controller: a1, abort: abortA1 } = fakeController();
    const { controller: a2, abort: abortA2 } = fakeController();
    const { controller: b1, abort: abortB1 } = fakeController();
    createPersistentPty("agent-a1", "canvas:proj-a", a1);
    createPersistentPty("agent-a2", "canvas:proj-a", a2);
    createPersistentPty("agent-b1", "canvas:proj-b", b1);

    destroyScopePersistentPtys("canvas:proj-a");

    expect(abortA1).toHaveBeenCalledTimes(1);
    expect(abortA2).toHaveBeenCalledTimes(1);
    expect(abortB1).not.toHaveBeenCalled();
    expect(hasPersistentPty("agent-a1")).toBe(false);
    expect(hasPersistentPty("agent-b1")).toBe(true);
  });

  it("bounds the transcript so a chatty long-lived agent cannot grow it without limit", () => {
    const { controller: ctrl } = fakeController();
    createPersistentPty("agent-1", "canvas:proj-a", ctrl);
    attachPersistentPty("agent-1", vi.fn(), vi.fn());
    for (let i = 0; i < 5000; i++) dispatchPersistentPtyOutput("agent-1", "x".repeat(1000));

    detachPersistentPty("agent-1");
    const sink = vi.fn();
    attachPersistentPty("agent-1", sink, vi.fn());
    const replayed = sink.mock.calls[0][0] as string;
    expect(replayed.length).toBeLessThanOrEqual(256_000);
  });
});

// A pooled PTY is not proof that a runner is running inside it. After a launch that never
// succeeded, the pool holds a bare shell — and reattaching to that adopted it as a live agent, so
// the pane sat at a prompt forever with no CLI (observed 2026-09-12).
describe("runner-launched mark", () => {
  it("starts false, so an unproven session is never adopted", () => {
    const key = "canvas:cp_1:agent-1";
    createPersistentPty(key, "canvas:cp_1", fakeController().controller);
    expect(hasRunnerLaunched(key)).toBe(false);
  });

  it("remembers a launch that actually came up, for as long as the PTY lives", () => {
    const key = "canvas:cp_1:agent-2";
    createPersistentPty(key, "canvas:cp_1", fakeController().controller);
    markRunnerLaunched(key);
    expect(hasRunnerLaunched(key)).toBe(true);
  });

  it("forgets when the PTY is destroyed, so the next one proves itself again", () => {
    const key = "canvas:cp_1:agent-3";
    createPersistentPty(key, "canvas:cp_1", fakeController().controller);
    markRunnerLaunched(key);
    destroyPersistentPty(key);
    expect(hasRunnerLaunched(key)).toBe(false);
  });

  it("says no for a key it has never seen", () => {
    expect(hasRunnerLaunched("canvas:cp_1:never")).toBe(false);
  });
});
