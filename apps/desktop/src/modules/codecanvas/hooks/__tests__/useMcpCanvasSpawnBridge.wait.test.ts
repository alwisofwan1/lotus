import { describe, expect, it } from "vitest";

import { waitForBoard, type McpCanvasSpawnDeps } from "../useMcpCanvasSpawnBridge";

/** Only the four fields `waitForBoard` reads; the rest of the bridge is not its concern. */
function deps(over: Partial<McpCanvasSpawnDeps>): McpCanvasSpawnDeps {
  return {
    spawnAgent: () => null,
    resolveFrame: (ref) => ({ id: ref }),
    activeProjectId: null,
    knownProjectIds: [],
    switchToProject: () => undefined,
    boardReady: true,
    ...over,
  };
}

/** A clock the test advances itself, so a 6s budget costs no wall time. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("waiting for a switched board", () => {
  it("returns as soon as the asked-for board is mounted and settled", async () => {
    const clock = fakeClock();
    let active = "cp_lotus";
    const live = () => deps({ activeProjectId: active, boardReady: true });
    // The switch lands on the third poll, the way a real re-render would.
    let polls = 0;
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      if (++polls === 3) active = "cp_demo";
    };

    await expect(waitForBoard("cp_demo", live, clock.now, sleep)).resolves.toBe(true);
  });

  /**
   * The half-mounted board is the trap. `activeProjectId` flips before the board finishes
   * loading, and spawning in that window puts the node on a board about to be replaced —
   * indistinguishable, from the phone, from the bug this whole change fixes.
   */
  it("does not settle while the board is still loading", async () => {
    const clock = fakeClock();
    const live = () => deps({ activeProjectId: "cp_demo", boardReady: false });

    await expect(waitForBoard("cp_demo", live, clock.now, clock.sleep)).resolves.toBe(false);
  });

  /** A switch that never lands must fail as a refusal we can word, not a silent spawn. */
  it("gives up when the board never arrives", async () => {
    const clock = fakeClock();
    const live = () => deps({ activeProjectId: "cp_lotus", boardReady: true });

    await expect(waitForBoard("cp_demo", live, clock.now, clock.sleep)).resolves.toBe(false);
  });

  it("costs nothing when the board is already the right one", async () => {
    const clock = fakeClock();
    const live = () => deps({ activeProjectId: "cp_demo", boardReady: true });

    await expect(waitForBoard("cp_demo", live, clock.now, clock.sleep)).resolves.toBe(true);
    expect(clock.now()).toBe(0);
  });
});
