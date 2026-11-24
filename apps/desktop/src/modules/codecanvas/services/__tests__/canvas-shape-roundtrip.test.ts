import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { toCanvasSnapshot } from "../canvas-serialize";
import { decodeCanvasSnapshot } from "../canvas-snapshot-codec";
import { recordToNode } from "../canvas-node-factory";
import { collectDiagrams } from "../agent-draw/diagram-edit";

// Reload path: live nodes -> serialize -> JSON -> decode -> node factory.
function reload(nodes: Node[]): Node[] {
  const snap = toCanvasSnapshot({ id: "c", rootDir: "/r", nodes, edges: [], noteContent: new Map() });
  const decoded = decodeCanvasSnapshot(JSON.parse(JSON.stringify(snap)));
  if (!decoded.ok) throw new Error(decoded.error);
  return decoded.snapshot.nodes.map((r) => recordToNode(r, "/r", null));
}

const shape = (id: string, data: Record<string, unknown>): Node => ({
  id, type: "shape", position: { x: 0, y: 0 }, width: 160, height: 60, data: { shape: "rectangle", ...data },
});

describe("shape reload round trip", () => {
  it("keeps angle", () => {
    const [n] = reload([shape("s1", { angle: 30 })]);
    expect((n.data as { angle?: number }).angle).toBe(30);
  });

  it("a diagram frame reloads as a real Frame; members keep their diagram marks", () => {
    const [frame, member] = reload([
      shape("f1", { diagramFrame: true, diagramId: "D1", areaLabel: "Login" }),
      shape("s1", { diagramId: "D1", diagramNodeId: "login", text: "Login" }),
    ]);
    expect(frame.type).toBe("frame");
    expect(frame.data).toMatchObject({ title: "Login", diagramId: "D1" });
    expect(member.data).toMatchObject({ diagramId: "D1", diagramNodeId: "login", frameId: "f1" });
  });

  it("agent edit-in-place still finds the diagram after reload", () => {
    const nodes = reload([
      shape("f1", { diagramFrame: true, diagramId: "D1", areaLabel: "Login" }),
      shape("s1", { diagramId: "D1", diagramNodeId: "login", text: "Login" }),
    ]);
    expect(collectDiagrams(nodes, [])).toHaveLength(1);
  });

  it("the migrated Frame is the diagram's frame: edit-in-place reuses it and keeps the title", () => {
    const nodes = reload([
      shape("f1", { diagramFrame: true, diagramId: "D1", areaLabel: "Login" }),
      shape("s1", { diagramId: "D1", diagramNodeId: "login", text: "Login" }),
    ]);
    const [d] = collectDiagrams(nodes, []);
    expect(d.frameId).toBe("f1");
    expect(d.title).toBe("Login");
    expect(d.nodeIds.sort()).toEqual(["f1", "s1"]);
  });
});
