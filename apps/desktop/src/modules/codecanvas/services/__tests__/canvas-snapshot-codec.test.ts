import { describe, expect, it } from "vitest";
import { decodeCanvasSnapshot } from "../canvas-snapshot-codec";

describe("decodeCanvasSnapshot", () => {
  it("keeps a note's edited time and cover, and loads an older note without them", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1,
      id: "canvas-1",
      rootDir: "/repo",
      nodes: [
        { type: "note", id: "n1", position: { x: 0, y: 0 }, size: { w: 300, h: 200 }, content: "a", editedAt: 1790000000000, coverUri: "lotus-note-asset://asset_9" },
        { type: "note", id: "n2", position: { x: 0, y: 0 }, size: { w: 300, h: 200 }, content: "b" },
        { type: "note", id: "n3", position: { x: 0, y: 0 }, size: { w: 300, h: 200 }, content: "c", editedAt: "yesterday" },
      ],
      edges: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const [edited, legacy, bad] = result.snapshot.nodes as { editedAt?: number; coverUri?: string }[];
    expect(edited.editedAt).toBe(1790000000000);
    expect(edited.coverUri).toBe("lotus-note-asset://asset_9");
    expect(legacy).not.toHaveProperty("coverUri");
    expect(legacy).not.toHaveProperty("editedAt");
    expect(bad).not.toHaveProperty("editedAt");
  });

  it("quarantines unknown nodes and drops edges touching them", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1,
      id: "canvas-1",
      rootDir: "/repo",
      nodes: [
        { type: "note", id: "n1", position: { x: 1, y: 2 }, size: { w: 300, h: 200 }, content: "ok" },
        { type: "mystery", id: "x1", position: { x: 3, y: 4 }, size: { w: 10, h: 10 } },
      ],
      edges: [
        { id: "e-ok", source: "n1", target: "n1" },
        { id: "e-bad", source: "x1", target: "n1" },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.nodes.map((node) => node.id)).toEqual(["n1"]);
    expect(result.snapshot.edges.map((edge) => edge.id)).toEqual(["e-ok"]);
    expect(result.repairs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "dropped-node", id: "x1" }),
      expect.objectContaining({ kind: "dropped-edge", id: "e-bad" }),
    ]));
  });

  it("normalizes invalid node position and size", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1,
      id: "canvas-1",
      rootDir: "/repo",
      nodes: [{ type: "note", id: "n1", position: { x: "bad", y: Number.NaN }, size: { w: -1, h: 0 }, content: "ok" }],
      edges: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.nodes[0]).toMatchObject({ position: { x: 0, y: 0 }, size: { w: 440, h: 520 } });
    expect(result.repairs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "normalized-node", id: "n1" }),
    ]));
  });

  it("preserves and normalizes terminal labels for durable targeting", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1,
      id: "canvas-1",
      rootDir: "/repo",
      nodes: [
        {
          type: "terminal",
          id: "t1",
          position: { x: 0, y: 0 },
          size: { w: 560, h: 360 },
          cwd: "/repo",
          terminalNumber: 2,
          label: "  API server  ",
          assignedWorktree: null,
        },
      ],
      edges: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.nodes[0]).toMatchObject({ type: "terminal", label: "API server" });
  });

  it("preserves browser labels for durable voice and agent targeting", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1,
      id: "canvas-1",
      rootDir: "/repo",
      nodes: [
        {
          type: "browser",
          id: "b1",
          position: { x: 0, y: 0 },
          size: { w: 640, h: 420 },
          parentTerminalId: null,
          url: "https://example.com",
          browserNumber: 1,
          label: "Preview",
        },
      ],
      edges: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.nodes[0]).toMatchObject({ type: "browser", label: "Preview" });
  });

  it("decodes an image shape, keeping its asset URI and intrinsic dimensions", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1, id: "c", rootDir: "/r",
      nodes: [{ type: "shape", id: "img1", position: { x: 4, y: 8 }, size: { w: 480, h: 270 }, shape: "image", imageAssetUri: "lotus-note-asset://asset_xyz", imageAlt: "shot", imageNaturalWidth: 1600, imageNaturalHeight: 900 }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.nodes[0]).toMatchObject({
      type: "shape", id: "img1", shape: "image",
      imageAssetUri: "lotus-note-asset://asset_xyz", imageAlt: "shot",
      imageNaturalWidth: 1600, imageNaturalHeight: 900,
    });
  });

  it("drops an image shape that lost its asset URI (nothing to render)", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1, id: "c", rootDir: "/r",
      nodes: [{ type: "shape", id: "orphan", position: { x: 0, y: 0 }, size: { w: 480, h: 270 }, shape: "image" }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.nodes).toHaveLength(0);
    expect(result.repairs).toContainEqual(expect.objectContaining({ kind: "dropped-node", id: "orphan" }));
  });

  it("decodes a shape node, defaulting an invalid kind and keeping valid style", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1, id: "c", rootDir: "/r", shapeCounter: 4,
      nodes: [{ type: "shape", id: "s1", position: { x: 2, y: 3 }, size: { w: 200, h: 140 }, shape: "nope", areaLabel: "flow", style: { strokeStyle: "dashed", opacity: 70, junk: 1 }, shapeNumber: 2 }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.shapeCounter).toBe(4);
    expect(result.snapshot.nodes[0]).toMatchObject({
      type: "shape", id: "s1", shape: "rectangle", areaLabel: "flow",
      style: { strokeStyle: "dashed", opacity: 70 }, shapeNumber: 2,
    });
  });

  it("preserves a live agent's execution mode through decode, ignoring invalid values (ADR-0022)", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1, id: "c", rootDir: "/r",
      nodes: [
        { type: "agent", id: "a-live", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "A", model: "m", prompt: "p", cwd: "/r", agentNumber: 1, executionMode: "live" },
        { type: "agent", id: "a-old", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "B", model: "m", prompt: "p", cwd: "/r", agentNumber: 2 },
        { type: "agent", id: "a-bad", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "C", model: "m", prompt: "p", cwd: "/r", agentNumber: 3, executionMode: "garbage" },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const byId = (id: string) => result.snapshot.nodes.find((n) => n.id === id) as unknown as Record<string, unknown>;
    expect(byId("a-live").executionMode).toBe("live");
    // Old snapshot has no field, and an invalid value is dropped — both fall back to headless on rebuild.
    expect(byId("a-old").executionMode).toBeUndefined();
    expect(byId("a-bad").executionMode).toBeUndefined();
  });

  it("preserves a valid agent runner through decode, dropping invalid values (ADR-0023)", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1, id: "c", rootDir: "/r",
      nodes: [
        { type: "agent", id: "a-codex", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "Rex", model: "m", prompt: "p", cwd: "/r", agentNumber: 1, runner: "codex" },
        { type: "agent", id: "a-none", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "A", model: "m", prompt: "p", cwd: "/r", agentNumber: 2 },
        { type: "agent", id: "a-bad", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "B", model: "m", prompt: "p", cwd: "/r", agentNumber: 3, runner: "bogus" },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const byId = (id: string) => result.snapshot.nodes.find((n) => n.id === id) as unknown as Record<string, unknown>;
    expect(byId("a-codex").runner).toBe("codex");
    expect(byId("a-none").runner).toBeUndefined();
    expect(byId("a-bad").runner).toBeUndefined();
  });

  it("preserves an agent's persona colour through decode (Slice 6)", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1, id: "c", rootDir: "/r",
      nodes: [
        { type: "agent", id: "a-col", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "Skye", model: "m", prompt: "p", cwd: "/r", agentNumber: 1, color: "#e879a6" },
        { type: "agent", id: "a-nocol", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "A", model: "m", prompt: "p", cwd: "/r", agentNumber: 2 },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const byId = (id: string) => result.snapshot.nodes.find((n) => n.id === id) as unknown as Record<string, unknown>;
    expect(byId("a-col").color).toBe("#e879a6");
    expect(byId("a-nocol").color).toBeUndefined();
  });

  it("preserves an agent's resumeSessionId through decode, dropping empty/non-string (ADR-0027 Phase 5)", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1, id: "c", rootDir: "/r",
      nodes: [
        { type: "agent", id: "a-res", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "Skye", model: "m", prompt: "p", cwd: "/r", agentNumber: 1, resumeSessionId: "sess-77" },
        { type: "agent", id: "a-fresh", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "A", model: "m", prompt: "p", cwd: "/r", agentNumber: 2 },
        { type: "agent", id: "a-empty", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, agentDefId: "d", name: "B", model: "m", prompt: "p", cwd: "/r", agentNumber: 3, resumeSessionId: "" },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const byId = (id: string) => result.snapshot.nodes.find((n) => n.id === id) as unknown as Record<string, unknown>;
    expect(byId("a-res").resumeSessionId).toBe("sess-77");
    expect(byId("a-fresh").resumeSessionId).toBeUndefined();
    expect(byId("a-empty").resumeSessionId).toBeUndefined();
  });

  it("keeps a task's blocked status and its BridgeTask workspace through decode", () => {
    const result = decodeCanvasSnapshot({
      schemaVersion: 1, id: "c", rootDir: "/r",
      nodes: [
        { type: "task", id: "t-linked", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, title: "T", status: "blocked", taskId: "task-1", taskWorkspaceId: "ws-1" },
        { type: "task", id: "t-local", position: { x: 0, y: 0 }, size: { w: 320, h: 240 }, title: "L", status: "bogus" },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const byId = (id: string) => result.snapshot.nodes.find((n) => n.id === id) as unknown as Record<string, unknown>;
    expect(byId("t-linked")).toMatchObject({ status: "blocked", taskId: "task-1", taskWorkspaceId: "ws-1" });
    expect(byId("t-local").status).toBe("todo");
    expect(byId("t-local").taskWorkspaceId).toBeUndefined();
  });

  it("returns an explicit error for unsupported schema versions", () => {
    const result = decodeCanvasSnapshot({ schemaVersion: 99, id: "future", nodes: [], edges: [] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected decode failure");
    expect(result.error).toContain("99");
  });
});
