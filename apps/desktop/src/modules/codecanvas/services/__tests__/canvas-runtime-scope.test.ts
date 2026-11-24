import { describe, expect, it } from "vitest";

import {
  canvasRuntimePaneId,
  canvasRuntimeScope,
  projectIdFromCanvasPaneId,
  projectIdFromCanvasScope,
} from "../canvas-runtime-scope";

describe("reading a project back out of an id", () => {
  it("round-trips a scope", () => {
    expect(projectIdFromCanvasScope(canvasRuntimeScope("cp_1"))).toBe("cp_1");
  });

  it("round-trips a pane id", () => {
    expect(projectIdFromCanvasPaneId(canvasRuntimePaneId("cp_1", "node-9"))).toBe("cp_1");
  });

  /**
   * The failure worth a test of its own: a pane id fed to the scope reader returns
   * `cp_1:node-9`, which is a project id that matches nothing — and matches nothing
   * *quietly*, so the board simply never switches and no error is raised anywhere.
   */
  it("does not let a pane id pass as a scope", () => {
    expect(projectIdFromCanvasScope("canvas:cp_1:node-9")).toBe("cp_1:node-9");
    expect(projectIdFromCanvasPaneId("canvas:cp_1:node-9")).toBe("cp_1");
  });

  it("says nothing for ids that name no project", () => {
    for (const value of [null, undefined, "", "node-9", "codespace:ws-7", "canvas:default"]) {
      expect(projectIdFromCanvasScope(value)).toBeNull();
    }
    for (const value of [null, undefined, "", "node-9", "canvas:cp_1", "canvas:default:node-9"]) {
      expect(projectIdFromCanvasPaneId(value)).toBeNull();
    }
  });
});
