import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { toCanvasSnapshot } from "../canvas-serialize";
import { decodeCanvasSnapshot } from "../canvas-snapshot-codec";
import { factoryNode, recordToNode } from "../canvas-node-factory";
import type { CanvasNodeRecord } from "../../types/canvas";

/** A Factory node keeps the issue it shows, across a save and a reopen (#146). */
describe("a Factory node on a saved canvas", () => {
  it("keeps its repo, issue and title, and comes back as a Factory node", () => {
    const node: Node = { ...factoryNode({ id: "f1", position: { x: 10, y: 20 }, repo: "o/r", issue: 6, title: "Exit lifecycle" }) };
    const snapshot = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: [node], edges: [], noteContent: new Map() });
    const decoded = decodeCanvasSnapshot(JSON.parse(JSON.stringify(snapshot)));
    const records: CanvasNodeRecord[] = decoded.ok ? decoded.snapshot.nodes : [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "factory", id: "f1", repo: "o/r", issue: 6, title: "Exit lifecycle", size: { w: 340, h: 200 } });
    const back = recordToNode(records[0], "/app", "proj-1");
    expect(back.type).toBe("factory");
    expect(back.data).toMatchObject({ repo: "o/r", issue: 6, title: "Exit lifecycle" });
  });

  it("drops a record that lost its issue, and says so", () => {
    const decoded = decodeCanvasSnapshot({
      schemaVersion: 1, id: "default", rootDir: "/app", edges: [],
      nodes: [{ type: "factory", id: "f2", position: { x: 0, y: 0 }, repo: "o/r", title: "orphan" }],
    });
    expect(decoded.ok && decoded.snapshot.nodes).toEqual([]);
    expect(decoded.repairs.map((r) => r.reason).join(" ")).toContain("repo or issue");
  });

  it("still opens a canvas saved before Factory nodes existed", () => {
    const decoded = decodeCanvasSnapshot({
      schemaVersion: 1, id: "default", rootDir: "/app", edges: [],
      nodes: [{ type: "note", id: "n1", position: { x: 0, y: 0 }, size: { w: 200, h: 120 }, content: "hi" }],
    });
    expect(decoded.ok && decoded.snapshot.nodes.map((n) => n.type)).toEqual(["note"]);
  });
});
