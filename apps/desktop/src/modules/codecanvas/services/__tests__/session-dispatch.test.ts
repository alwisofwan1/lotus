import { describe, expect, it } from "vitest";
import { dispatchActionLabel, planSessionDispatch } from "../session-dispatch";
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

const board = {
  projectId: "cp_1",
  isRegistered: () => true,
  isDormant: () => false,
  activeSessionId: () => null as string | null,
};

describe("planSessionDispatch", () => {
  // The reported symptom, stated as a rule: a row pointing at a node that is not on this board is
  // not un-runnable, it just needs a node first. Sessions are keyed by project, one project holds
  // many canvases, and the registry only knows the canvas you are looking at — so "has a nodeId"
  // was never the same question as "can be acted on here".
  it("adopts a session whose node is not on this board", () => {
    expect(
      planSessionDispatch(session(), { ...board, isRegistered: () => false }),
    ).toEqual({ kind: "adopt" });
  });

  // A row with no node has never been different from a row whose node is gone — the panel drew them
  // as two kinds ("tersimpan" vs "lepas dari node") and only one of them worked.
  it("adopts a session that never had a node either", () => {
    expect(planSessionDispatch(session({ nodeId: null }), board)).toEqual({ kind: "adopt" });
  });

  // Focus, not relaunch: the CLI is alive and in this very conversation, and a relaunch would kill
  // it to start an identical one. This is also what stops a second PTY from appearing.
  it("takes you to a conversation that is already running here", () => {
    expect(
      planSessionDispatch(session({ status: "live" }), {
        ...board,
        activeSessionId: () => "sess-1",
      }),
    ).toEqual({ kind: "focus", nodeId: "agent-1" });
  });

  it("wakes a sleeping node that is already pointed at this conversation", () => {
    expect(
      planSessionDispatch(session(), {
        ...board,
        isDormant: () => true,
        activeSessionId: () => "sess-1",
      }),
    ).toEqual({ kind: "wake", nodeId: "agent-1" });
  });

  it("relaunches a node that is busy with a different conversation", () => {
    expect(
      planSessionDispatch(session(), { ...board, activeSessionId: () => "sess-other" }),
    ).toEqual({ kind: "relaunch", nodeId: "agent-1" });
  });

  // A resume against an id the runner has forgotten drops the user into a bare pane, which reads as
  // "my session was destroyed". Better to say so and offer a fresh start.
  it("refuses a conversation the runner no longer knows", () => {
    expect(planSessionDispatch(session({ status: "dead" }), board)).toEqual({
      kind: "blocked",
      reason: "dead-session",
    });
  });

  // Found live, 2026-09-12: pressing "pasang" on a custom-runner session threw
  // `custom runner requires a command` out of `resolveRunnerCommand` during render. The session row
  // records the runner TYPE ("custom") and never the command that made it, so a node rebuilt from
  // the row has nothing to launch. Older rows will never have one, so the refusal has to be a real
  // verdict rather than an exception.
  it("refuses to adopt a custom-runner session whose command was never recorded", () => {
    expect(
      planSessionDispatch(session({ runner: "custom" }), { ...board, isRegistered: () => false }),
    ).toEqual({ kind: "blocked", reason: "no-runner-command" });
  });

  it("adopts a custom-runner session that does carry its command", () => {
    expect(
      planSessionDispatch(session({ runner: "custom", runnerCommand: "grok --yolo" }), {
        ...board,
        isRegistered: () => false,
      }),
    ).toEqual({ kind: "adopt" });
  });

  // Only adoption rebuilds a node from the row. A node that is already on the board knows its own
  // command, so nothing has to be recovered.
  it("still relaunches a custom-runner session on a node that already exists", () => {
    expect(planSessionDispatch(session({ runner: "custom" }), board)).toEqual({
      kind: "relaunch",
      nodeId: "agent-1",
    });
  });

  it("refuses when there is no project to run in", () => {
    expect(planSessionDispatch(session(), { ...board, projectId: null })).toEqual({
      kind: "blocked",
      reason: "no-project",
    });
  });
});

describe("dispatchActionLabel", () => {
  // The panel used to draw two kinds of row — "tersimpan" and "lepas dari node" — and only told the
  // truth about one of them. The label now comes from the same plan that decides what the click
  // does, so it cannot promise "lanjut" and then do nothing.
  // One word since 2026-11-13: the dispatcher decides focus / wake / relaunch / adopt.
  it("says Open for every row that can be acted on", () => {
    expect(dispatchActionLabel({ kind: "focus", nodeId: "agent-1" })).toBe("Open");
    expect(dispatchActionLabel({ kind: "wake", nodeId: "agent-1" })).toBe("Open");
    expect(dispatchActionLabel({ kind: "relaunch", nodeId: "agent-1" })).toBe("Open");
    expect(dispatchActionLabel({ kind: "adopt" })).toBe("Open");
  });

  it("offers nothing on a row that cannot be acted on", () => {
    expect(dispatchActionLabel({ kind: "blocked", reason: "dead-session" })).toBeNull();
  });
});
