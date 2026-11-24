import { describe, expect, it, vi } from "vitest";
import { createSessionControlHandle } from "../session-control-handle";
import type { CanvasSessionRecord } from "../session-record";

function session(overrides: Partial<CanvasSessionRecord> = {}): CanvasSessionRecord {
  return {
    id: "sess-1",
    projectId: "cp_1",
    nodeId: "agent-1",
    runner: "claude",
    status: "resumable",
    createdAt: 0,
    lastActivityAt: 0,
    ...overrides,
  } as CanvasSessionRecord;
}

function effects(overrides: Partial<Parameters<typeof createSessionControlHandle>[0]> = {}) {
  return {
    sessions: () => [] as CanvasSessionRecord[],
    activeSessionId: () => null,
    facts: () => ({ projectId: "cp_1", activeSessionId: null, awaitingAnswer: false }),
    isDormant: () => false,
    wake: vi.fn(),
    relaunch: vi.fn(),
    ...overrides,
  };
}

describe("session control handle", () => {
  // The worst of the two bugs: `needs-you` exists precisely to protect a pane that is mid-question,
  // and the old path executed the kill before the verdict ever reached a caller. Judging has to
  // happen before anything is destroyed.
  it("does not touch the runtime while a pane is waiting on a human", () => {
    const fx = effects({
      facts: () => ({ projectId: "cp_1", activeSessionId: null, awaitingAnswer: true }),
    });
    const handle = createSessionControlHandle(fx);

    const verdict = handle.request({ kind: "resume", session: session() });

    expect(verdict).toMatchObject({ allowed: true, confirm: "needs-you" });
    expect(fx.relaunch).not.toHaveBeenCalled();
  });

  it("relaunches exactly once when the human says yes", () => {
    const fx = effects({
      facts: () => ({ projectId: "cp_1", activeSessionId: null, awaitingAnswer: true }),
    });
    const handle = createSessionControlHandle(fx);
    const intent = { kind: "resume" as const, session: session() };

    handle.request(intent);
    handle.commit(intent);

    expect(fx.relaunch).toHaveBeenCalledTimes(1);
    expect(fx.relaunch).toHaveBeenCalledWith(intent);
  });

  it("keeps the runtime untouched when the verdict refuses", () => {
    const fx = effects({
      activeSessionId: () => "sess-1",
      facts: () => ({ projectId: "cp_1", activeSessionId: "sess-1", awaitingAnswer: false }),
    });
    const handle = createSessionControlHandle(fx);

    expect(handle.request({ kind: "resume", session: session({ id: "sess-1" }) })).toEqual({
      allowed: false,
      reason: "already-active",
    });
    expect(fx.relaunch).not.toHaveBeenCalled();
    expect(fx.wake).not.toHaveBeenCalled();
  });

  // The `adopt` path: a node made for this very session already carries the pointer, so it must
  // skip the dormant card rather than ask for a second click. Waking is all it needs — and a
  // relaunch there would be actively wrong, since it would hand the board a pointer it already has
  // and wait forever for a change that never comes.
  it("wakes a freshly adopted node without relaunching it", () => {
    const fx = effects({ isDormant: () => true });
    const handle = createSessionControlHandle(fx);

    handle.wake();

    expect(fx.wake).toHaveBeenCalledTimes(1);
    expect(fx.relaunch).not.toHaveBeenCalled();
  });

  it("leaves an already-awake node alone when asked to wake", () => {
    const fx = effects({ isDormant: () => false });
    createSessionControlHandle(fx).wake();
    expect(fx.wake).not.toHaveBeenCalled();
  });

  // A sleeping node has no process to kill. Relaunching it would be a no-op wrapped in a kill, and
  // the kill is the part that can go wrong.
  it("only wakes a sleeping node that is already pointed at the conversation", () => {
    const fx = effects({
      isDormant: () => true,
      activeSessionId: () => "sess-1",
      facts: () => ({ projectId: "cp_1", activeSessionId: "sess-1", awaitingAnswer: false }),
    });
    const handle = createSessionControlHandle(fx);

    const verdict = handle.request({ kind: "resume", session: session({ id: "sess-1" }) });

    expect(verdict).toMatchObject({ allowed: true });
    expect(fx.wake).toHaveBeenCalledTimes(1);
    expect(fx.relaunch).not.toHaveBeenCalled();
  });
});
