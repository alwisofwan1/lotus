import { beforeEach, describe, expect, it } from "vitest";
import {
  canvasProjectViewStateStore,
  resetCanvasProjectViewStateStoreForTests,
} from "../canvas-project-view-state";

describe("canvasProjectViewStateStore", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCanvasProjectViewStateStoreForTests();
  });

  it("clears the remembered focus when the user returns to board mode", () => {
    canvasProjectViewStateStore.rememberFocus("project-a", "agent-a");
    canvasProjectViewStateStore.rememberBoard("project-a");

    expect(canvasProjectViewStateStore.read("project-a")).toEqual({ version: 1, mode: "board", heroNodeId: null });
  });

  it("remembers focus and its hero", () => {
    canvasProjectViewStateStore.rememberFocus("project-a", "agent-a");

    expect(canvasProjectViewStateStore.read("project-a")).toEqual({ version: 1, mode: "focus", heroNodeId: "agent-a" });
  });

  it("reads a save from the fleet-rail days as plain focus on the same hero", () => {
    localStorage.setItem(
      "lotus.codecanvas.view.project-a",
      JSON.stringify({ version: 1, mode: "fleet", heroNodeId: "agent-a", railScrollTop: 184 }),
    );

    expect(canvasProjectViewStateStore.read("project-a")).toEqual({ version: 1, mode: "focus", heroNodeId: "agent-a" });
  });

  it("forgets the view when its project is closed", () => {
    canvasProjectViewStateStore.rememberFocus("project-a", "agent-a");
    canvasProjectViewStateStore.forget("project-a");

    expect(canvasProjectViewStateStore.read("project-a")).toEqual({ version: 1, mode: "board", heroNodeId: null });
  });

  it("keeps each project's hero independent", () => {
    canvasProjectViewStateStore.rememberFocus("project-a", "agent-a");
    canvasProjectViewStateStore.rememberFocus("project-b", "agent-b");

    expect(canvasProjectViewStateStore.read("project-a")).toMatchObject({ heroNodeId: "agent-a" });
    expect(canvasProjectViewStateStore.read("project-b")).toMatchObject({ heroNodeId: "agent-b" });
  });
});
