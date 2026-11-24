import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { toCanvasSnapshot } from "../canvas-serialize";
import { decodeCanvasSnapshot } from "../canvas-snapshot-codec";
import { recordToNode } from "../canvas-node-factory";

// Reload path: live nodes -> serialize -> JSON -> decode -> node factory.
function reload(nodes: Node[]): Node[] {
  const snap = toCanvasSnapshot({ id: "c", rootDir: "/r", nodes, edges: [], noteContent: new Map() });
  const decoded = decodeCanvasSnapshot(JSON.parse(JSON.stringify(snap)));
  if (!decoded.ok) throw new Error(decoded.error);
  return decoded.snapshot.nodes.map((r) => recordToNode(r, "/r", null));
}

const frame = (id: string, data: Record<string, unknown> = {}): Node => ({
  id, type: "frame", position: { x: 10, y: 20 }, width: 500, height: 400, data: { title: "Backend", colorId: "sage", ...data },
});
const member = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({
  id, type, position: { x: 50, y: 60 }, width: 200, height: 120, data: { frameId: "fr1", ...data },
});

describe("Frame node round trip", () => {
  it("keeps title, colour, size and position", () => {
    const [n] = reload([frame("fr1")]);
    expect(n.type).toBe("frame");
    expect(n.position).toEqual({ x: 10, y: 20 });
    expect(n.width).toBe(500);
    expect(n.height).toBe(400);
    expect(n.data).toMatchObject({ title: "Backend", colorId: "sage" });
  });

  it("keeps the task key a task's spawned cells were grouped under", () => {
    const [n] = reload([frame("fr1", { taskKey: "task_1" })]);
    expect((n.data as { taskKey?: string }).taskKey).toBe("task_1");
  });

  it("a Frame with no task key loads without one", () => {
    const [n] = reload([frame("fr1")]);
    expect(n.data).not.toHaveProperty("taskKey");
  });

  it("a Frame with no colour loads without one", () => {
    const [n] = reload([frame("fr1", { colorId: undefined })]);
    expect(n.data).not.toHaveProperty("colorId");
  });
});

describe("frame reference round trip, every node kind", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["terminal", { cwd: "/r", terminalNumber: 1 }],
    ["agent", { agentDefId: "a", name: "A", model: "m", prompt: "p", cwd: "/r", agentNumber: 1 }],
    ["browser", { url: "http://x", browserNumber: 1 }],
    ["note", {}],
    ["shape", { shape: "rectangle" }],
    ["run", { title: "Run", memberIds: [] }],
    ["plan", { title: "P", steps: [] }],
    ["task", { title: "T" }],
    ["team", { cwd: "/r", name: "T" }],
    ["context", { title: "C" }],
    ["critic", { title: "C" }],
    ["human-gate", { title: "H" }],
    ["music", {}],
    ["host-cell", { adoptedPaneId: "p1", cwd: "/r", label: "l", provider: "claude" }],
  ];

  it.each(cases)("%s keeps its frame reference", (type, data) => {
    const [, n] = reload([frame("fr1"), member("m1", type, data)]);
    expect(n.type).toBe(type);
    expect((n.data as { frameId?: string }).frameId).toBe("fr1");
  });

  it("a node without a Frame loads without a reference", () => {
    const [n] = reload([{ ...member("m1", "note"), data: {} }]);
    expect(n.data).not.toHaveProperty("frameId");
  });

  it("drops a reference to a Frame that is not in the snapshot", () => {
    const [n] = reload([member("m1", "note")]);
    expect(n.data).not.toHaveProperty("frameId");
  });

  it("drops a reference that points at a non-Frame node", () => {
    const [, n] = reload([member("other", "note", { frameId: undefined }), member("m1", "note", { frameId: "other" })]);
    expect(n.data).not.toHaveProperty("frameId");
  });
});
