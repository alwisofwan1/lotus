import { describe, expect, it } from "vitest";
import type { CanvasSessionRecord, CanvasSessionStatus } from "../session-record";
import { planSessionReconciliation } from "../session-reconcile";

function session(
  overrides: Partial<CanvasSessionRecord> & { id: string; status?: CanvasSessionStatus },
): CanvasSessionRecord {
  return {
    projectId: "cp_1",
    nodeId: `node-${overrides.id}`,
    runner: "claude",
    cwd: "/repos/demo",
    title: `Session ${overrides.id}`,
    status: "live",
    origin: "manual",
    turnCount: 1,
    lastActivityAt: 0,
    createdAt: 0,
    ...overrides,
  };
}

const paneIdForNode = (nodeId: string) => `canvas:cp_1:${nodeId}`;

describe("planSessionReconciliation", () => {
  // The force-quit case: rows say live, nothing is running.
  it("demotes a live row with no process behind it", () => {
    const stale = session({ id: "a" });
    const changes = planSessionReconciliation({
      sessions: [stale],
      livePaneIds: [],
      paneIdForNode,
    });
    expect(changes).toEqual([{ session: stale, from: "live", to: "resumable" }]);
  });

  it("leaves a row alone when its PTY really is there", () => {
    const running = session({ id: "a" });
    const changes = planSessionReconciliation({
      sessions: [running],
      livePaneIds: ["canvas:cp_1:node-a"],
      paneIdForNode,
    });
    expect(changes).toEqual([]);
  });

  it("ignores rows that never claimed to be running", () => {
    const changes = planSessionReconciliation({
      sessions: [
        session({ id: "a", status: "resumable" }),
        session({ id: "b", status: "dead" }),
        session({ id: "c", status: "no-resume" }),
      ],
      livePaneIds: [],
      paneIdForNode,
    });
    expect(changes).toEqual([]);
  });

  // A session whose node has left the board cannot have a process, whatever the pane list says.
  it("demotes a live row that has no node at all", () => {
    const orphan = session({ id: "a", nodeId: null });
    const changes = planSessionReconciliation({
      sessions: [orphan],
      livePaneIds: ["canvas:cp_1:node-a"],
      paneIdForNode,
    });
    expect(changes.map((c) => c.to)).toEqual(["resumable"]);
  });

  // Falling back to "resumable" for a runner that cannot resume would promise something the button
  // could not deliver.
  it("falls back to no-resume for a runner that cannot continue a conversation", () => {
    const changes = planSessionReconciliation({
      sessions: [session({ id: "a", runner: "opencode" })],
      livePaneIds: [],
      paneIdForNode,
      canResume: (s) => s.runner !== "opencode",
    });
    expect(changes.map((c) => c.to)).toEqual(["no-resume"]);
  });

  // Promotion is the node's job: it owns the process, and guessing from here would race it.
  it("never promotes a row to live", () => {
    const changes = planSessionReconciliation({
      sessions: [session({ id: "a", status: "resumable" })],
      livePaneIds: ["canvas:cp_1:node-a"],
      paneIdForNode,
    });
    expect(changes).toEqual([]);
  });

  it("reports every stale row in one pass", () => {
    const changes = planSessionReconciliation({
      sessions: [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })],
      livePaneIds: ["canvas:cp_1:node-b"],
      paneIdForNode,
    });
    expect(changes.map((c) => c.session.id)).toEqual(["a", "c"]);
  });
});
