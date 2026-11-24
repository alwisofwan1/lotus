import { describe, it, expect } from "vitest";
import type { Node, Edge } from "@xyflow/react";
import { CanvasRunScheduler, buildRunGraph, descendantsOf } from "../canvas-run-scheduler";

describe("buildRunGraph", () => {
  const nodes: Node[] = [
    { id: "a", type: "agent", position: { x: 0, y: 0 }, data: {} },
    { id: "b", type: "agent", position: { x: 0, y: 0 }, data: {} },
    { id: "note", type: "note", position: { x: 0, y: 0 }, data: {} },
  ];
  const edges: Edge[] = [
    { id: "e1", source: "a", target: "b", data: { wireKind: "triggers" } },
    { id: "e2", source: "b", target: "note", data: { wireKind: "data-flow" } },
    { id: "e3", source: "a", target: "note", data: { wireKind: "default" } },
  ];

  it("keeps only agent nodes and execution edges between them", () => {
    const graph = buildRunGraph(nodes, edges);
    expect(graph.nodeIds.sort()).toEqual(["a", "b"]);
    expect(graph.deps).toEqual([{ from: "a", to: "b" }]);
  });

  it("includes team nodes as runnable composite agents in execution edges", () => {
    const withTeam: Node[] = [
      { id: "a", type: "agent", position: { x: 0, y: 0 }, data: {} },
      { id: "team", type: "team", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "agent", position: { x: 0, y: 0 }, data: {} },
    ];
    const teamEdges: Edge[] = [
      { id: "e1", source: "a", target: "team", data: { wireKind: "triggers" } },
      { id: "e2", source: "team", target: "b", data: { wireKind: "triggers" } },
    ];
    const graph = buildRunGraph(withTeam, teamEdges);
    expect(graph.nodeIds.sort()).toEqual(["a", "b", "team"]);
    expect(graph.deps).toEqual([{ from: "a", to: "team" }, { from: "team", to: "b" }]);
  });

  it("includes human gate nodes as runnable pause points in execution edges", () => {
    const withGate: Node[] = [
      { id: "a", type: "agent", position: { x: 0, y: 0 }, data: {} },
      { id: "g", type: "human-gate", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "agent", position: { x: 0, y: 0 }, data: {} },
    ];
    const gateEdges: Edge[] = [
      { id: "e1", source: "a", target: "g", data: { wireKind: "triggers" } },
      { id: "e2", source: "g", target: "b", data: { wireKind: "triggers" } },
    ];
    const graph = buildRunGraph(withGate, gateEdges);
    expect(graph.nodeIds.sort()).toEqual(["a", "b", "g"]);
    expect(graph.deps).toEqual([{ from: "a", to: "g" }, { from: "g", to: "b" }]);
  });

  it("includes critic nodes as runnable and wires agent↔critic execution edges", () => {
    const withCritic: Node[] = [
      { id: "a", type: "agent", position: { x: 0, y: 0 }, data: {} },
      { id: "c", type: "critic", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "agent", position: { x: 0, y: 0 }, data: {} },
    ];
    const criticEdges: Edge[] = [
      { id: "e1", source: "a", target: "c", data: { wireKind: "triggers" } },
      { id: "e2", source: "c", target: "b", data: { wireKind: "triggers" } },
    ];
    const graph = buildRunGraph(withCritic, criticEdges);
    expect(graph.nodeIds.sort()).toEqual(["a", "b", "c"]);
    expect(graph.deps).toEqual([{ from: "a", to: "c" }, { from: "c", to: "b" }]);
  });
});

describe("CanvasRunScheduler gate (block)", () => {
  it("blocks a failed gate's descendants so they never dispatch, yet the run settles", () => {
    // a → c(critic) → b ; c fails its verdict → b is gated off.
    const s = new CanvasRunScheduler(["a", "c", "b"], [{ from: "a", to: "c" }, { from: "c", to: "b" }]);
    expect(s.start()).toEqual(["a"]);
    expect(s.complete("a")).toEqual(["c"]); // critic released
    const blocked = s.block("c");           // critic verdict = fail
    expect(blocked).toEqual(["b"]);
    expect(s.complete("c")).toEqual([]);    // b is blocked → not released
    expect(s.isDone()).toBe(true);          // a,c done + b blocked = all accounted
  });

  it("releases downstream normally when the gate passes (no block call)", () => {
    const s = new CanvasRunScheduler(["a", "c", "b"], [{ from: "a", to: "c" }, { from: "c", to: "b" }]);
    s.start(); s.complete("a");
    expect(s.complete("c")).toEqual(["b"]); // gate passed → b released
  });
});

describe("CanvasRunScheduler", () => {
  it("starts the roots (nodes with no unmet dependency)", () => {
    const s = new CanvasRunScheduler(["a", "b"], [{ from: "a", to: "b" }]);
    expect(s.start().sort()).toEqual(["a"]);
  });

  it("releases a dependent only after its dependency completes", () => {
    const s = new CanvasRunScheduler(["a", "b"], [{ from: "a", to: "b" }]);
    s.start();
    expect(s.complete("a")).toEqual(["b"]);
    expect(s.complete("b")).toEqual([]);
    expect(s.isDone()).toBe(true);
  });

  it("runs independent roots in parallel", () => {
    const s = new CanvasRunScheduler(["a", "b", "c"], [{ from: "a", to: "c" }, { from: "b", to: "c" }]);
    expect(s.start().sort()).toEqual(["a", "b"]);
    expect(s.complete("a")).toEqual([]); // c still waits on b
    expect(s.complete("b")).toEqual(["c"]);
  });

  it("does not release a node until ALL dependencies complete", () => {
    const s = new CanvasRunScheduler(["a", "b", "c"], [{ from: "a", to: "c" }, { from: "b", to: "c" }]);
    s.start();
    s.complete("a");
    expect(s.isDone()).toBe(false);
  });

  it("detects a cycle as unrunnable instead of deadlocking", () => {
    const s = new CanvasRunScheduler(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }]);
    expect(s.start()).toEqual([]);
    expect(s.hasCycle()).toBe(true);
  });

  it("resumes from seeded completed nodes without re-dispatching them", () => {
    const s = new CanvasRunScheduler(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }], ["a"]);
    expect(s.start()).toEqual(["b"]); // a is already done; b becomes runnable, a is not re-handed-out
    expect(s.isDone()).toBe(false);
    expect(s.complete("b")).toEqual(["c"]);
    expect(s.complete("c")).toEqual([]);
    expect(s.isDone()).toBe(true);
  });

  it("is immediately done when every node is seeded complete", () => {
    const s = new CanvasRunScheduler(["a", "b"], [{ from: "a", to: "b" }], ["a", "b"]);
    expect(s.start()).toEqual([]);
    expect(s.isDone()).toBe(true);
  });

  it("hands out runnable nodes in deterministic sorted order", () => {
    const s = new CanvasRunScheduler(["c", "a", "b"], []);
    expect(s.start()).toEqual(["a", "b", "c"]);
  });
});

describe("descendantsOf", () => {
  const deps = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "x", to: "y" }];

  it("returns all transitive descendants, sorted", () => {
    expect(descendantsOf("a", deps)).toEqual(["b", "c"]);
    expect(descendantsOf("b", deps)).toEqual(["c"]);
    expect(descendantsOf("c", deps)).toEqual([]);
  });

  it("is safe against dependency cycles", () => {
    const cyclic = [{ from: "a", to: "b" }, { from: "b", to: "a" }];
    expect(descendantsOf("a", cyclic)).toEqual(["a", "b"]);
  });
});
