import { describe, expect, it, vi } from "vitest";
import { TerminalV2RendererPool } from "../terminal-v2-renderer-pool";

describe("TerminalV2RendererPool", () => {
  it("evicts the lowest-priority lease when capacity is exceeded", () => {
    const captureSnapshot = vi.fn((paneId: string) => `snapshot:${paneId}`);
    const pool = new TerminalV2RendererPool({ capacity: 2, captureSnapshot });

    pool.bind({ paneId: "hidden-pane", visible: false });
    pool.bind({ paneId: "visible-pane", visible: true });
    const plan = pool.bind({ paneId: "next-pane", visible: true });

    expect(plan.evicted).toEqual({
      paneId: "hidden-pane",
      slotId: "renderer-1",
      snapshot: "snapshot:hidden-pane",
    });
    expect(pool.getLeases().map((lease) => lease.paneId).sort()).toEqual([
      "next-pane",
      "visible-pane",
    ]);
  });

  it("keeps focused and agent-active panes ahead of inactive panes", () => {
    const pool = new TerminalV2RendererPool({ capacity: 2 });

    pool.bind({ paneId: "agent-pane", visible: true, agentActive: true });
    pool.bind({ paneId: "inactive-pane", visible: false });
    const plan = pool.bind({ paneId: "focused-pane", visible: true, focused: true });

    expect(plan.evicted?.paneId).toBe("inactive-pane");
    expect(pool.getLeases().map((lease) => lease.paneId).sort()).toEqual([
      "agent-pane",
      "focused-pane",
    ]);
  });

  it("evicts a background pane before a visible pane on screen, however recently it was used", () => {
    // Panes of a hidden Code workspace stay attached so switching back costs nothing. They are
    // still `visible` to the pool, so without this rule the least-recently-bound pane — often
    // one on screen — would lose its slot to a pane nobody can see.
    let clock = 0;
    const background = new Set(["hidden-workspace-pane"]);
    const pool = new TerminalV2RendererPool({
      capacity: 2,
      now: () => ++clock,
      isBackground: (paneId) => background.has(paneId),
    });

    pool.bind({ paneId: "on-screen-pane", visible: true });
    pool.bind({ paneId: "hidden-workspace-pane", visible: true, agentActive: true, focused: true });
    const plan = pool.bind({ paneId: "new-pane", visible: true });

    expect(plan.evicted?.paneId).toBe("hidden-workspace-pane");
  });

  it("captures snapshots on release and restores them on the next bind", () => {
    const pool = new TerminalV2RendererPool({
      capacity: 1,
      captureSnapshot: (paneId) => `snapshot:${paneId}`,
    });

    pool.bind({ paneId: "pane-1", visible: true });
    expect(pool.release("pane-1")).toEqual({
      paneId: "pane-1",
      slotId: "renderer-1",
      snapshot: "snapshot:pane-1",
    });

    expect(pool.bind({ paneId: "pane-1", visible: true })).toMatchObject({
      kind: "bound",
      paneId: "pane-1",
      slotId: "renderer-1",
      restore: {
        snapshot: "snapshot:pane-1",
        drainOutput: true,
        fit: true,
        repaint: true,
      },
    });
  });

  it("reuses the same renderer slot for a pane that is already bound", () => {
    const pool = new TerminalV2RendererPool({ capacity: 2, now: () => 100 });

    const first = pool.bind({ paneId: "pane-1", visible: true });
    const second = pool.bind({ paneId: "pane-1", visible: true, focused: true });

    expect(first).toMatchObject({ kind: "bound", paneId: "pane-1", slotId: "renderer-1" });
    expect(second).toMatchObject({ kind: "reused", paneId: "pane-1", slotId: "renderer-1" });
    expect(pool.getLeases()).toHaveLength(1);
  });
});
