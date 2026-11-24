import { describe, it, expect } from "vitest";
import {
  createSpawnDepthRegistry,
  nodeIdFromPaneId,
  spawnDepthExceededMessage,
  MAX_SPAWN_DEPTH,
} from "../canvas-spawn-depth";

describe("nodeIdFromPaneId", () => {
  it("pulls the node id out of a project-scoped canvas pane id", () => {
    expect(nodeIdFromPaneId("canvas:cp_2c73:node-atlas-1")).toBe("node-atlas-1");
  });

  it("keeps a bare node id (project-less canvas pane)", () => {
    expect(nodeIdFromPaneId("node-atlas-1")).toBe("node-atlas-1");
  });

  it("keeps colons inside the node id itself", () => {
    expect(nodeIdFromPaneId("canvas:cp_2c73:node:with:colons")).toBe("node:with:colons");
  });

  it("returns null for a missing or empty pane id", () => {
    expect(nodeIdFromPaneId(undefined)).toBeNull();
    expect(nodeIdFromPaneId(null)).toBeNull();
    expect(nodeIdFromPaneId("   ")).toBeNull();
  });

  it("leaves a non-canvas pane id alone — a codespace cell is not a canvas node", () => {
    expect(nodeIdFromPaneId("p-nova")).toBe("p-nova");
  });
});

describe("createSpawnDepthRegistry", () => {
  it("treats an unrecorded node as a root — an agent the user spawned", () => {
    const depth = createSpawnDepthRegistry();
    expect(depth.depthOf("never-seen")).toBe(0);
    expect(depth.wouldExceed("never-seen")).toBe(false);
  });

  it("counts each generation from its parent", () => {
    const depth = createSpawnDepthRegistry();
    expect(depth.record("child", "root")).toBe(1);
    expect(depth.record("grandchild", "child")).toBe(2);
    expect(depth.depthOf("grandchild")).toBe(2);
  });

  it("refuses the generation past the ceiling and never records it", () => {
    const depth = createSpawnDepthRegistry();
    let parent = "root";
    for (let generation = 1; generation <= MAX_SPAWN_DEPTH; generation += 1) {
      expect(depth.wouldExceed(parent)).toBe(false);
      const child = `gen-${generation}`;
      expect(depth.record(child, parent)).toBe(generation);
      parent = child;
    }
    // parent is now at the ceiling — it may not spawn again.
    expect(depth.depthOf(parent)).toBe(MAX_SPAWN_DEPTH);
    expect(depth.wouldExceed(parent)).toBe(true);
  });

  it("keeps a human spawn at the root regardless of what else ran", () => {
    const depth = createSpawnDepthRegistry();
    depth.record("child", "root");
    expect(depth.record("manual", null)).toBe(0);
    expect(depth.wouldExceed("manual")).toBe(false);
  });

  it("forgets every lineage on reset", () => {
    const depth = createSpawnDepthRegistry();
    depth.record("child", "root");
    depth.record("grandchild", "child");
    depth.reset();
    expect(depth.depthOf("grandchild")).toBe(0);
  });

  it("names the ceiling in the refusal so the agent reports instead of retrying", () => {
    const message = spawnDepthExceededMessage(2);
    expect(message).toContain(String(MAX_SPAWN_DEPTH));
    expect(message).toMatch(/depth 2/i);
  });
});
