import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { toCanvasSnapshot } from "../canvas-serialize";
import { decodeCanvasSnapshot } from "../canvas-snapshot-codec";
import { fileNode, recordToNode } from "../canvas-node-factory";
import { getNodeSize, DEFAULT_FILE_NODE_SIZE } from "../canvas-node-placement";
import type { CanvasNodeRecord } from "../../types/canvas";

function roundTrip(nodes: Node[]) {
  const snapshot = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges: [], noteContent: new Map() });
  return decodeCanvasSnapshot(JSON.parse(JSON.stringify(snapshot)));
}

/**
 * Every place a node kind is dispatched on has a silent fallback (serialize -> note, codec ->
 * browser, render -> terminal). A File Node that misses one reopens as the wrong thing with no
 * error, so the whole path is held here.
 */
describe("a File Node on a saved canvas", () => {
  it("keeps its path, scroll line, size and Frame, and comes back as a File Node with no repairs", () => {
    const node: Node = {
      ...fileNode({ id: "f1", position: { x: 10, y: 20 }, path: "/app/src/auth/session.ts", topLine: 42, size: { w: 500, h: 400 } }),
      data: { path: "/app/src/auth/session.ts", viewport: { topLine: 42 }, frameId: "fr1" },
    };
    const frame: Node = { id: "fr1", type: "frame", position: { x: 0, y: 0 }, data: { title: "T" }, width: 900, height: 700 };
    const decoded = roundTrip([frame, node]);
    expect(decoded.ok).toBe(true);
    expect(decoded.repairs).toEqual([]);
    const records: CanvasNodeRecord[] = decoded.ok ? decoded.snapshot.nodes : [];
    const file = records.find((r) => r.id === "f1");
    expect(file).toMatchObject({
      type: "file", path: "/app/src/auth/session.ts", viewport: { topLine: 42 }, size: { w: 500, h: 400 }, position: { x: 10, y: 20 }, frameId: "fr1",
    });
    const back = recordToNode(file!, "/app", "proj-1");
    expect(back.type).toBe("file");
    expect(back.data).toMatchObject({ path: "/app/src/auth/session.ts", viewport: { topLine: 42 } });
  });

  it("never becomes a note, browser or terminal", () => {
    const decoded = roundTrip([fileNode({ id: "f2", position: { x: 0, y: 0 }, path: "/app/a.ts" })]);
    const types = decoded.ok ? decoded.snapshot.nodes.map((n) => n.type) : [];
    expect(types).toEqual(["file"]);
  });

  it("stores the path only, never the file's contents", () => {
    const node: Node = { ...fileNode({ id: "f3", position: { x: 0, y: 0 }, path: "/app/a.ts" }) };
    node.data = { ...node.data, content: "SECRET", lines: ["SECRET"] };
    const snapshot = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: [node], edges: [], noteContent: new Map() });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
  });

  it("drops a record with a missing or blank path, and says so, instead of drawing a note", () => {
    const decoded = decodeCanvasSnapshot({
      schemaVersion: 1, id: "default", rootDir: "/app", edges: [],
      nodes: [
        { type: "file", id: "f4", position: { x: 0, y: 0 } },
        { type: "file", id: "f5", position: { x: 0, y: 0 }, path: "   " },
        { type: "file", id: "f6", position: { x: 0, y: 0 }, path: 7 },
      ],
    });
    expect(decoded.ok && decoded.snapshot.nodes).toEqual([]);
    expect(decoded.repairs.filter((r) => r.kind === "dropped-node")).toHaveLength(3);
    expect(decoded.repairs.map((r) => r.reason).join(" ")).toContain("path");
  });

  it("repairs an invalid scroll line rather than keeping it", () => {
    const decoded = decodeCanvasSnapshot({
      schemaVersion: 1, id: "default", rootDir: "/app", edges: [],
      nodes: [{ type: "file", id: "f7", position: { x: 0, y: 0 }, path: "/app/a.ts", viewport: { topLine: -3 } }],
    });
    const rec = decoded.ok ? decoded.snapshot.nodes[0] : null;
    expect(rec).toMatchObject({ type: "file", path: "/app/a.ts" });
    expect(rec && "viewport" in rec ? rec.viewport : undefined).toBeUndefined();
  });

  it("measures itself with the File Node's default size, not the note's", () => {
    const node = { id: "f8", type: "file", position: { x: 0, y: 0 }, data: {} } as Node;
    expect(getNodeSize(node)).toEqual(DEFAULT_FILE_NODE_SIZE);
  });
});
