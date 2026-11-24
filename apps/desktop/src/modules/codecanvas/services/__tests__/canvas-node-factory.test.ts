import { describe, expect, it } from "vitest";
import type { CanvasNodeRecord } from "../../types/canvas";
import { browserNode, noteNode, planNode, recordToNode, shapeNode, skillNode, skillsNode, teamNode, terminalNode } from "../canvas-node-factory";

describe("node builders", () => {
  it("mirrors width/height into top-level and style so ReactFlow renders them", () => {
    const node = noteNode("n1", { x: 1, y: 2 }, "hi");
    expect(node).toMatchObject({
      id: "n1",
      type: "note",
      position: { x: 1, y: 2 },
      data: { content: "hi" },
      width: 440,
      height: 520,
      style: { width: 440, height: 520 },
      draggable: true,
      dragHandle: ".canvas-node-header, .canvas-node-glyph",
    });
  });

  it("derives a terminal's runtime scope and pane id from the active project", () => {
    const node = terminalNode({ id: "t1", cwd: "/p", terminalNumber: 4, position: { x: 0, y: 0 }, activeProjectId: "proj" });
    expect(node.data).toMatchObject({ cwd: "/p", terminalNumber: 4, assignedWorktree: null });
    expect(typeof node.data?.runtimePaneId).toBe("string");
  });

  it("defaults plan title/steps and builds skill data fields", () => {
    expect(planNode({ id: "p1", position: { x: 0, y: 0 }, cwd: "/p" }).data).toMatchObject({ title: "Plan", steps: [] });
    const skill = skillNode({ id: "s1", position: { x: 0, y: 0 }, skill: { name: "ship", source: "project", content: "# Ship" } });
    expect(skill.data).toMatchObject({ skillName: "ship", source: "project", content: "# Ship" });
    expect(skillsNode({ id: "sk", position: { x: 0, y: 0 }, parentTerminalId: "t1", cwd: "/p" }).data).toMatchObject({
      parentTerminalId: "t1",
      cwd: "/p",
    });
  });

  it("builds team nodes with embedded runnable members", () => {
    const node = teamNode({
      id: "team-1",
      position: { x: 1, y: 2 },
      name: "Coder Team",
      description: "Implementation squad",
      goal: "Ship the approved plan",
      members: [{ id: "coder", name: "Coder", role: "Developer", model: "claude-sonnet-4-6", prompt: "Build", appliedSkills: [], updatedAt: 0 }],
    });
    expect(node).toMatchObject({
      id: "team-1",
      type: "team",
      width: 480,
      height: 320,
      data: { name: "Coder Team", goal: "Ship the approved plan", members: [expect.objectContaining({ name: "Coder" })] },
    });
  });

  it("does not create blank browser nodes in perpetual loading state", () => {
    const blank = browserNode({ id: "b1", position: { x: 0, y: 0 }, parentTerminalId: null, url: "about:blank", browserNumber: 1 });
    const target = browserNode({ id: "b2", position: { x: 0, y: 0 }, parentTerminalId: null, url: "https://example.com", browserNumber: 2 });
    const labelled = browserNode({ id: "b3", position: { x: 0, y: 0 }, parentTerminalId: null, url: "https://example.com", browserNumber: 3, label: "Preview" });

    expect(blank.data).toMatchObject({ state: "disconnected" });
    expect(target.data).toMatchObject({ state: "loading" });
    expect(labelled.data).toMatchObject({ label: "Preview" });
  });

  it("keeps browser viewport preferences on browser nodes", () => {
    const node = browserNode({
      id: "b1",
      position: { x: 0, y: 0 },
      parentTerminalId: null,
      url: "https://example.com",
      browserNumber: 1,
      viewportMode: "mobile",
      viewportOrientation: "portrait",
      viewportWidth: 390,
      viewportHeight: 844,
      viewportScaleMode: "fit",
      viewportZoom: 0.75,
    });

    expect(node.data).toMatchObject({
      viewportMode: "mobile",
      viewportOrientation: "portrait",
      viewportWidth: 390,
      viewportHeight: 844,
      viewportScaleMode: "fit",
      viewportZoom: 0.75,
    });
  });
});

describe("recordToNode", () => {
  it("preserves the stored size of a hydrated terminal record", () => {
    const record: CanvasNodeRecord = {
      type: "terminal",
      id: "t1",
      position: { x: 10, y: 20 },
      size: { w: 900, h: 400 },
      cwd: "/p",
      terminalNumber: 2,
      label: "API server",
      assignedWorktree: "feat",
    };
    const node = recordToNode(record, "/root", null);
    expect(node).toMatchObject({ width: 900, height: 400, position: { x: 10, y: 20 } });
    expect(node.data).toMatchObject({ assignedWorktree: "feat", terminalNumber: 2, label: "API server" });
  });

  it("hydrates team records into live team nodes", () => {
    const record: CanvasNodeRecord = {
      type: "team",
      id: "team-1",
      position: { x: 10, y: 20 },
      size: { w: 380, h: 260 },
      cwd: "",
      teamId: "team_feature_dev_01",
      name: "Coder Team",
      description: "Implementation squad",
      goal: "Ship the approved plan",
      members: [{ id: "coder", name: "Coder", role: "Developer", model: "claude-sonnet-4-6", prompt: "Build", appliedSkills: [], updatedAt: 0 }],
    };
    const node = recordToNode(record, "/repo", null);
    expect(node).toMatchObject({ type: "team", width: 380, height: 260 });
    expect(node.data).toMatchObject({ cwd: "/repo", teamId: "team_feature_dev_01", name: "Coder Team" });
  });

  it("hydrates browser viewport preferences from snapshots", () => {
    const record: CanvasNodeRecord = {
      type: "browser",
      id: "browser-1",
      position: { x: 10, y: 20 },
      size: { w: 420, h: 560 },
      parentTerminalId: null,
      url: "https://example.com",
      state: "disconnected",
      browserNumber: 1,
      viewportMode: "mobile",
      viewportOrientation: "portrait",
      viewportWidth: 390,
      viewportHeight: 844,
      viewportScaleMode: "fit",
      viewportZoom: 0.75,
    };

    expect(recordToNode(record, "/root", null).data).toMatchObject({
      viewportMode: "mobile",
      viewportOrientation: "portrait",
      viewportWidth: 390,
      viewportHeight: 844,
      viewportScaleMode: "fit",
      viewportZoom: 0.75,
    });
  });

  it("builds a shape node and hydrates a shape record (kind/style/size preserved)", () => {
    const node = shapeNode({ id: "sh1", position: { x: 4, y: 5 }, shape: "diamond" });
    expect(node).toMatchObject({ id: "sh1", type: "shape", data: { shape: "diamond" }, width: 200, height: 140 });

    const record: CanvasNodeRecord = {
      type: "shape", id: "sh2", position: { x: 12, y: 34 }, size: { w: 260, h: 180 },
      shape: "ellipse", areaLabel: "flow", style: { strokeColor: "#fff", opacity: 80 }, shapeNumber: 2,
    };
    const hydrated = recordToNode(record, "/root", null);
    expect(hydrated).toMatchObject({ type: "shape", width: 260, height: 180, position: { x: 12, y: 34 } });
    expect(hydrated.data).toMatchObject({ shape: "ellipse", areaLabel: "flow", style: { strokeColor: "#fff", opacity: 80 }, shapeNumber: 2 });
  });

  it("builds + hydrates an image shape, preserving asset URI and intrinsic dimensions", () => {
    const node = shapeNode({
      id: "img1", position: { x: 4, y: 5 }, shape: "image", size: { w: 480, h: 270 },
      imageAssetUri: "lotus-note-asset://asset_abc", imageAlt: "shot", imageNaturalWidth: 1600, imageNaturalHeight: 900,
    });
    expect(node.data).toMatchObject({
      shape: "image", imageAssetUri: "lotus-note-asset://asset_abc", imageAlt: "shot",
      imageNaturalWidth: 1600, imageNaturalHeight: 900,
    });

    const record: CanvasNodeRecord = {
      type: "shape", id: "img2", position: { x: 1, y: 2 }, size: { w: 480, h: 270 },
      shape: "image", imageAssetUri: "lotus-note-asset://asset_xyz", imageAlt: "grab", imageNaturalWidth: 800, imageNaturalHeight: 600,
    };
    const hydrated = recordToNode(record, "/root", null);
    expect(hydrated.data).toMatchObject({
      shape: "image", imageAssetUri: "lotus-note-asset://asset_xyz", imageAlt: "grab",
      imageNaturalWidth: 800, imageNaturalHeight: 600,
    });
  });

  it("clamps wildly off-canvas positions back to a visible origin", () => {
    const record: CanvasNodeRecord = {
      type: "note",
      id: "n1",
      position: { x: -9000, y: 12000 },
      size: { w: 300, h: 200 },
      content: "rescued",
    };
    expect(recordToNode(record, "/root", null).position).toEqual({ x: 80, y: 80 });
  });

  it("falls back a terminal's cwd to the canvas rootDir when empty", () => {
    const record: CanvasNodeRecord = {
      type: "terminal",
      id: "t2",
      position: { x: 0, y: 0 },
      size: { w: 560, h: 360 },
      cwd: "",
      terminalNumber: 1,
      assignedWorktree: null,
    };
    expect(recordToNode(record, "/root", null).data).toMatchObject({ cwd: "/root" });
  });
});
