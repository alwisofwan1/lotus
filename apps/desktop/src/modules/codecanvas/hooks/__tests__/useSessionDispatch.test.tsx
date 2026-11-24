import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSessionDispatch, type SessionDispatchDeps } from "../useSessionDispatch";
import { createAgentSessionControlRegistry } from "../../services/session-control-registry";
import { createSessionControlHandle } from "../../services/session-control-handle";
import type { CanvasSessionRecord } from "../../services/session-record";

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

function setup(overrides: Partial<SessionDispatchDeps> = {}) {
  const registry = createAgentSessionControlRegistry();
  const deps: SessionDispatchDeps = {
    projectId: "cp_1",
    registry,
    focusNode: vi.fn(),
    adoptSession: vi.fn(async () => "agent-1"),
    notify: vi.fn(),
    confirmNeedsYou: vi.fn(async () => true),
    waitTimeoutMs: 20,
    ...overrides,
  };
  const { result } = renderHook(() => useSessionDispatch(deps));
  return { registry, deps, dispatch: (s: CanvasSessionRecord) => result.current.dispatch(s) };
}

describe("useSessionDispatch", () => {
  // The reported symptom, end to end: a row whose node is not on this board used to do nothing at
  // all. It must now make the node, wait for it, and run it — one gesture, no second click.
  it("adopts a session whose node is absent, then wakes the node it made", async () => {
    const registry = createAgentSessionControlRegistry();
    const wake = vi.fn();
    const adoptSession = vi.fn(async () => {
      // The node mounts a tick later, as a real one does.
      setTimeout(
        () =>
          registry.register(
            "agent-1",
            createSessionControlHandle({
              sessions: () => [],
              activeSessionId: () => "sess-1",
              facts: () => ({ projectId: "cp_1", activeSessionId: "sess-1" }),
              isDormant: () => true,
              wake,
              relaunch: vi.fn(),
            }),
          ),
        0,
      );
      return "agent-1";
    });
    const { dispatch, deps } = setup({ registry, adoptSession });

    await dispatch(session());

    expect(adoptSession).toHaveBeenCalled();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  // A node that never mounts must become a sentence. Silence here is the original bug wearing a
  // different hat.
  it("says so when the node it made never arrives", async () => {
    const { dispatch, deps } = setup({ adoptSession: vi.fn(async () => "agent-1") });

    await dispatch(session());

    expect(deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error", text: expect.stringContaining("not ready") }),
    );
  });

  it("takes you to a live conversation instead of starting a second one", async () => {
    const registry = createAgentSessionControlRegistry();
    const relaunch = vi.fn();
    registry.register(
      "agent-1",
      createSessionControlHandle({
        sessions: () => [],
        activeSessionId: () => "sess-1",
        facts: () => ({ projectId: "cp_1", activeSessionId: "sess-1" }),
        isDormant: () => false,
        wake: vi.fn(),
        relaunch,
      }),
    );
    const { dispatch, deps } = setup({ registry });

    await dispatch(session({ status: "live" }));

    expect(deps.focusNode).toHaveBeenCalledWith("agent-1");
    expect(relaunch).not.toHaveBeenCalled();
    expect(deps.adoptSession).not.toHaveBeenCalled();
  });

  // The verdict that matters most: the pane is mid-question, so nothing may be killed until the
  // human has actually been asked.
  it("asks before relaunching a pane that is waiting on an answer, and obeys a no", async () => {
    const registry = createAgentSessionControlRegistry();
    const relaunch = vi.fn();
    registry.register(
      "agent-1",
      createSessionControlHandle({
        sessions: () => [],
        activeSessionId: () => "sess-other",
        facts: () => ({
          projectId: "cp_1",
          activeSessionId: "sess-other",
          awaitingAnswer: true,
        }),
        isDormant: () => false,
        wake: vi.fn(),
        relaunch,
      }),
    );
    const confirmNeedsYou = vi.fn(async () => false);
    const { dispatch } = setup({ registry, confirmNeedsYou });

    const pressed = session();
    await dispatch(pressed);

    // Asked about the row that was pressed, so the list can ask inside that row.
    expect(confirmNeedsYou).toHaveBeenCalledTimes(1);
    expect(confirmNeedsYou).toHaveBeenCalledWith(pressed);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("relaunches once the human agrees", async () => {
    const registry = createAgentSessionControlRegistry();
    const relaunch = vi.fn();
    registry.register(
      "agent-1",
      createSessionControlHandle({
        sessions: () => [],
        activeSessionId: () => "sess-other",
        facts: () => ({
          projectId: "cp_1",
          activeSessionId: "sess-other",
          awaitingAnswer: true,
        }),
        isDormant: () => false,
        wake: vi.fn(),
        relaunch,
      }),
    );
    const { dispatch } = setup({ registry, confirmNeedsYou: vi.fn(async () => true) });

    await dispatch(session());

    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("explains a refusal instead of doing nothing", async () => {
    const registry = createAgentSessionControlRegistry();
    registry.register(
      "agent-1",
      createSessionControlHandle({
        sessions: () => [],
        activeSessionId: () => "sess-1",
        facts: () => ({ projectId: "cp_1", activeSessionId: "sess-1" }),
        isDormant: () => false,
        wake: vi.fn(),
        relaunch: vi.fn(),
      }),
    );
    // `live` would focus; a stored row pointing at the conversation the node is already in is the
    // one that reaches the judge and comes back refused.
    const { dispatch, deps } = setup({ registry, focusNode: vi.fn() });

    await dispatch(session({ status: "dead" }));

    expect(deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error", text: expect.stringContaining("no longer has") }),
    );
  });
});
