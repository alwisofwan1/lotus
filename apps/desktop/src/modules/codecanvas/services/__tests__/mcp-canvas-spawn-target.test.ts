import { describe, expect, it } from "vitest";

import { decideSpawnTarget } from "../mcp-canvas-spawn-target";

const KNOWN = ["cp_lotus", "cp_demo"];

describe("where a remote spawn lands", () => {
  /**
   * The reported bug. Pocket switched to `codespace-demo`, started an agent, and got one
   * in `Lotus` — because the bridge read the mounted board instead of the request. The
   * request had survived Pocket, the host façade and Rust intact; only the last layer
   * dropped it.
   */
  it("does not spawn on the board that happens to be mounted", () => {
    const target = decideSpawnTarget("canvas:cp_demo", "cp_lotus", KNOWN);

    expect(target).toEqual({
      kind: "switch-first",
      projectId: "cp_demo",
      workspaceId: "canvas:cp_demo",
    });
  });

  it("spawns straight away when the board asked for is already on screen", () => {
    expect(decideSpawnTarget("canvas:cp_lotus", "cp_lotus", KNOWN)).toEqual({ kind: "spawn-here" });
  });

  /**
   * Agent-to-agent spawns never named a workspace, and they predate the phone. Reading an
   * absent field as a refusal would break them to fix something they never did.
   */
  it("treats an unnamed workspace as the caller not caring", () => {
    expect(decideSpawnTarget(undefined, "cp_lotus", KNOWN)).toEqual({ kind: "spawn-here" });
    expect(decideSpawnTarget("   ", "cp_lotus", KNOWN)).toEqual({ kind: "spawn-here" });
  });

  /**
   * A phone can hold a project the desktop has since closed. Substituting the current
   * board is what produced the bug; refusing gives the operator a sentence they can act on.
   */
  it("refuses a project this window cannot open, instead of substituting one", () => {
    const target = decideSpawnTarget("canvas:cp_gone", "cp_lotus", KNOWN);

    expect(target.kind).toBe("refuse");
    expect(target.kind === "refuse" && target.reason).toContain("cp_gone");
  });

  /** A codespace/swarm id is not something a canvas board can open either. */
  it("refuses a workspace id that is not a canvas project at all", () => {
    const target = decideSpawnTarget("codespace:ws-7", "cp_lotus", KNOWN);

    expect(target.kind).toBe("refuse");
    expect(target.kind === "refuse" && target.reason).toContain("codespace:ws-7");
  });

  /** `canvas:default` names no project, so it cannot be switched to. */
  it("refuses the default scope rather than guessing which project it meant", () => {
    expect(decideSpawnTarget("canvas:default", "cp_lotus", KNOWN).kind).toBe("refuse");
  });

  /** With no board mounted there is nothing to compare against — the request still rules. */
  it("still routes by the request when no board is mounted yet", () => {
    expect(decideSpawnTarget("canvas:cp_demo", null, KNOWN)).toEqual({
      kind: "switch-first",
      projectId: "cp_demo",
      workspaceId: "canvas:cp_demo",
    });
  });
});
