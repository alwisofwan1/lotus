import { describe, expect, it } from "vitest";

import { projectToFollow } from "../useCanvasFollowPaneBridge";

const KNOWN = ["cp_lotus", "cp_demo"];

describe("following a pane a remote operator spoke to", () => {
  /**
   * The reported half the spawn fix did not cover. Dispatch never reaches the frontend —
   * Rust resolves the pane to its PTY and writes — so the prompt lands on an agent whose
   * project is not open and the desktop stays on the wrong board.
   */
  it("switches to the project of a pane that is not on screen", () => {
    expect(projectToFollow("canvas:cp_demo:node-9", "cp_lotus", KNOWN)).toBe("cp_demo");
  });

  it("stays put when the pane is already on the visible board", () => {
    expect(projectToFollow("canvas:cp_lotus:node-9", "cp_lotus", KNOWN)).toBeNull();
  });

  /**
   * A pane id with no project — an unscoped node — must not be read as "switch to
   * something". Following it would move the board for no reason anyone could explain.
   */
  it("stays put for a pane id that names no project", () => {
    expect(projectToFollow("node-9", "cp_lotus", KNOWN)).toBeNull();
    expect(projectToFollow(undefined, "cp_lotus", KNOWN)).toBeNull();
    expect(projectToFollow("canvas:default:node-9", "cp_lotus", KNOWN)).toBeNull();
  });

  /**
   * Silence, not an error: the dispatch already succeeded by the time this is decided, so
   * a project this window cannot open changes nothing the operator asked for.
   */
  it("stays put for a project this window cannot open", () => {
    expect(projectToFollow("canvas:cp_gone:node-9", "cp_lotus", KNOWN)).toBeNull();
  });

  it("still follows when no board is mounted yet", () => {
    expect(projectToFollow("canvas:cp_demo:node-9", null, KNOWN)).toBe("cp_demo");
  });
});
