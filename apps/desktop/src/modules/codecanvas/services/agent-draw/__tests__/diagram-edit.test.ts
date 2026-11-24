import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { collectDiagrams, findEditTargetDiagram, formatCurrentDiagrams, planDiagramReplace, type DiagramSummary } from "../diagram-edit";

// A shape node belonging to diagram `d`, semantic id `nid`.
const dShape = (nodeId: string, d: string, nid: string, label: string, x = 0, y = 0): Node => ({
  id: nodeId, type: "shape", position: { x, y }, width: 160, height: 60,
  data: { shape: "rectangle", diagramId: d, diagramNodeId: nid, text: label },
});
const dFrame = (nodeId: string, d: string, title: string, x = -30, y = -40): Node => ({
  id: nodeId, type: "shape", position: { x, y }, width: 400, height: 400,
  data: { shape: "rectangle", diagramId: d, diagramFrame: true, areaLabel: title },
});
const wire = (id: string, source: string, target: string, label?: string): Edge => ({
  id, source, target, type: "canvas-wire", data: { wireKind: "connector", ...(label ? { customLabel: label } : {}) },
});

const login = () => ({
  nodes: [
    dFrame("f1", "D1", "Login flow"),
    dShape("n1", "D1", "start", "Start", 40, 20),
    dShape("n2", "D1", "login", "Login form", 40, 120),
    dShape("n3", "D1", "valid", "Valid?", 40, 240),
  ],
  edges: [wire("e1", "n1", "n2"), wire("e2", "n2", "n3", "submit")],
});

describe("collectDiagrams", () => {
  it("groups shapes by diagramId with title, members, and edges keyed by semantic ids", () => {
    const { nodes, edges } = login();
    const diagrams = collectDiagrams(nodes, edges);
    expect(diagrams).toHaveLength(1);
    const d = diagrams[0];
    expect(d.diagramId).toBe("D1");
    expect(d.title).toBe("Login flow");
    expect(d.nodes.map((n) => n.diagramNodeId)).toEqual(["start", "login", "valid"]);
    expect(d.edges).toEqual([
      { from: "start", to: "login" },
      { from: "login", to: "valid", label: "submit" },
    ]);
  });

  it("ignores shapes without a diagramId (hand-drawn shapes)", () => {
    const loose: Node = { id: "x", type: "shape", position: { x: 0, y: 0 }, data: { shape: "ellipse", text: "loose" } };
    expect(collectDiagrams([loose], [])).toEqual([]);
  });

  it("separates two distinct diagrams", () => {
    const { nodes, edges } = login();
    const d2 = dShape("m1", "D2", "a", "Other", 900, 0);
    expect(collectDiagrams([...nodes, d2], edges).map((d) => d.diagramId).sort()).toEqual(["D1", "D2"]);
  });
});

describe("findEditTargetDiagram", () => {
  const diagrams = collectDiagrams(login().nodes, login().edges);

  it("returns the diagram whose node ids overlap the new graph (an edit)", () => {
    expect(findEditTargetDiagram(diagrams, ["start", "login", "valid", "verify"])).toBe("D1");
  });

  it("returns null when the new graph shares no ids (a brand-new diagram)", () => {
    expect(findEditTargetDiagram(diagrams, ["a", "b", "c"])).toBeNull();
  });

  it("picks the diagram with the largest overlap when several match", () => {
    const two = collectDiagrams(
      [...login().nodes, dShape("z1", "D2", "start", "S2"), dShape("z2", "D2", "login", "L2")],
      login().edges,
    );
    // D1 has start+login+valid (3 overlap), D2 has start+login (2) → D1 wins.
    expect(findEditTargetDiagram(two, ["start", "login", "valid"])).toBe("D1");
  });
});

describe("planDiagramReplace", () => {
  it("returns the anchor (diagram top-left) and every node id of the target to remove", () => {
    const { nodes, edges } = login();
    const diagrams = collectDiagrams(nodes, edges);
    const plan = planDiagramReplace(diagrams, "D1");
    expect(plan).not.toBeNull();
    // Top-left = min across the frame + members (the frame at -30,-40 is the corner).
    expect(plan!.anchor).toEqual({ x: -30, y: -40 });
    expect(plan!.removeNodeIds.sort()).toEqual(["f1", "n1", "n2", "n3"]);
  });

  it("returns null for an unknown diagram id", () => {
    expect(planDiagramReplace([], "nope")).toBeNull();
  });
});

describe("formatCurrentDiagrams", () => {
  it("renders a compact, id-bearing line per diagram so the model can reuse ids to edit", () => {
    const lines = formatCurrentDiagrams(collectDiagrams(login().nodes, login().edges));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Login flow");
    expect(lines[0]).toContain("start=Start");
    expect(lines[0]).toContain("login=Login form");
    expect(lines[0]).toMatch(/login\s*→\s*valid/);
  });

  it("returns an empty list when there are no diagrams", () => {
    expect(formatCurrentDiagrams([])).toEqual([]);
  });

  /**
   * This block is sent to the BYOK provider on EVERY NL command, not just diagram ones, so it must be
   * bounded — it used to grow without limit with the canvas, carrying the user's own domain labels.
   */
  describe("bounded output", () => {
    const bigDiagram = (id: string, nodeCount: number, edgeCount: number): DiagramSummary => ({
      diagramId: id,
      title: `Topology ${id}`,
      nodes: Array.from({ length: nodeCount }, (_, n) => ({
        nodeId: `canvas-${id}-${n}`,
        diagramNodeId: `${id}n${n}`,
        label: `SettlementWorker ${n}`,
        shape: "rectangle",
      })),
      edges: Array.from({ length: edgeCount }, (_, e) => ({
        from: `${id}n${e % Math.max(nodeCount, 1)}`,
        to: `${id}n${(e + 1) % Math.max(nodeCount, 1)}`,
        label: "publishes settlement.v2",
      })),
      nodeIds: [],
      topLeft: { x: 0, y: 0 },
    });

    it("caps how many diagrams are listed and says how many were withheld", () => {
      const lines = formatCurrentDiagrams(Array.from({ length: 9 }, (_, i) => bigDiagram(`d${i}`, 3, 2)));
      // 6 listed + 1 summary line.
      expect(lines).toHaveLength(7);
      expect(lines[6]).toBe("(+3 more diagrams on the canvas, not listed.)");
    });

    it("caps elements per diagram with a marker, so a trimmed list is never read as 'this node does not exist'", () => {
      const [line] = formatCurrentDiagrams([bigDiagram("d0", 50, 44)]);
      // A silent truncation would make the model mint a fresh id and redraw instead of editing in place.
      expect(line).toContain("…+20 more");
      expect(line).toContain("…+14 more");
      expect(line).toContain("d0n0=SettlementWorker 0");
      expect(line).not.toContain("d0n49");
    });

    it("leaves a realistic canvas completely untouched", () => {
      const modest = [bigDiagram("d0", 12, 14), bigDiagram("d1", 6, 5)];
      const lines = formatCurrentDiagrams(modest);
      expect(lines).toHaveLength(2);
      expect(lines.join("\n")).not.toContain("more");
      expect(lines[0]).toContain("d0n11=SettlementWorker 11");
    });

    it("keeps the whole block bounded even on a pathological canvas", () => {
      const huge = Array.from({ length: 40 }, (_, i) => bigDiagram(`d${i}`, 200, 200));
      const chars = formatCurrentDiagrams(huge).join("\n").length;
      // Previously this grew linearly with the canvas and had no ceiling at all: these 40 diagrams
      // would have rendered ~700KB. The cap holds it near the worst case of 6 fully-populated diagrams.
      expect(chars).toBeLessThan(14_000);
    });
  });
});
