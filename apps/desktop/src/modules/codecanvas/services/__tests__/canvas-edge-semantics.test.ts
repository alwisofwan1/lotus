import { describe, it, expect } from "vitest";
import { inferEdgeKind, cycleEdgeKind, restoredEdgeKind, EDGE_KIND_LABEL, isAgentWorkflowKind, isSemanticEdgeKind } from "../canvas-edge-semantics";
import { buildRunGraph, isRunnableNodeType } from "../canvas-run-scheduler";

describe("inferEdgeKind", () => {
  it("treats an agent → agent connection as a trigger dependency", () => {
    expect(inferEdgeKind("agent", "agent")).toBe("triggers");
  });

  it("treats note → agent as context and agent → note as data flow", () => {
    expect(inferEdgeKind("note", "agent")).toBe("context");
    expect(inferEdgeKind("agent", "note")).toBe("data-flow");
  });

  it("wires the context bus: agent → context writes, context → agent reads", () => {
    expect(inferEdgeKind("agent", "context")).toBe("data-flow");
    expect(inferEdgeKind("context", "agent")).toBe("context");
  });

  it("wires a critic gate as execution edges on both sides", () => {
    expect(inferEdgeKind("agent", "critic")).toBe("triggers");
    expect(inferEdgeKind("critic", "agent")).toBe("triggers");
  });

  it("a critic → critic wire is a run order too (#112)", () => {
    expect(inferEdgeKind("critic", "critic")).toBe("triggers");
  });

  it("every wire between two runnable nodes is an execution edge — none looks wired but runs in parallel (#112)", () => {
    const runnable = ["agent", "team", "critic", "human-gate"];
    expect(runnable.every(isRunnableNodeType)).toBe(true);
    for (const from of runnable) for (const to of runnable) {
      expect(["triggers", "orchestrates"], `${from} → ${to}`).toContain(inferEdgeKind(from, to));
    }
  });

  it("uses an agent workflow fallback for other agent connections", () => {
    expect(inferEdgeKind("terminal", "agent")).toBe("agent-link");
    expect(inferEdgeKind("agent", "terminal")).toBe("agent-link");
  });

  it("falls back to a plain wire for non-agent connections", () => {
    expect(inferEdgeKind("terminal", "note")).toBe("default");
    expect(inferEdgeKind(undefined, undefined)).toBe("default");
  });
});

describe("restoredEdgeKind (#112)", () => {
  it("a critic → critic wire saved as plain loads as triggers", () => {
    expect(restoredEdgeKind(undefined, "critic", "critic")).toBe("triggers");
    expect(restoredEdgeKind("default", "critic", "critic")).toBe("triggers");
  });

  it("every other saved kind is kept, plain wires elsewhere stay plain", () => {
    expect(restoredEdgeKind("orchestrates", "agent", "agent")).toBe("orchestrates");
    expect(restoredEdgeKind("data-flow", "critic", "critic")).toBe("data-flow");
    expect(restoredEdgeKind(undefined, "terminal", "note")).toBe("default");
    expect(restoredEdgeKind(undefined, "agent", "agent")).toBe("default");
  });

  it("Note → Critic 1 → Critic 2 drawn on the board runs the critics one after the other", () => {
    const node = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, data: {} });
    const nodes = [node("n", "note"), node("c1", "critic"), node("c2", "critic")];
    const wire = (source: string, target: string) => ({
      id: `${source}-${target}`, source, target, data: { wireKind: inferEdgeKind(nodes.find((x) => x.id === source)!.type, nodes.find((x) => x.id === target)!.type) },
    });
    expect(buildRunGraph(nodes, [wire("n", "c1"), wire("c1", "c2")]).deps).toEqual([{ from: "c1", to: "c2" }]);
  });
});

describe("cycleEdgeKind", () => {
  it("cycles a semantic edge through the execution kinds", () => {
    expect(cycleEdgeKind("triggers", "agent", "agent")).toBe("orchestrates");
    expect(cycleEdgeKind("orchestrates", "agent", "agent")).toBe("triggers");
  });

  it("starts the cycle for a non-semantic edge", () => {
    expect(cycleEdgeKind("default", "agent", "agent")).toBe("triggers");
  });
});

describe("edge kind metadata", () => {
  it("only marks execution kinds as semantic", () => {
    expect(isSemanticEdgeKind("triggers")).toBe(true);
    expect(isSemanticEdgeKind("context")).toBe(true);
    expect(isAgentWorkflowKind("context")).toBe(true);
    expect(isAgentWorkflowKind("skills")).toBe(false);
    expect(isSemanticEdgeKind("default")).toBe(false);
    expect(isSemanticEdgeKind("skills")).toBe(false);
  });

  it("provides a short label for each semantic kind", () => {
    expect(EDGE_KIND_LABEL.context).toBe("context");
    expect(EDGE_KIND_LABEL.triggers).toBeTruthy();
    expect(EDGE_KIND_LABEL["data-flow"]).toBeTruthy();
  });
});

describe("File Node wires (plans/canvas-code, S4)", () => {
  it("a File Node wired to an agent or an agent's terminal is a context wire", () => {
    expect(inferEdgeKind("file", "agent")).toBe("context");
    expect(inferEdgeKind("file", "terminal")).toBe("context");
    expect(inferEdgeKind("file", "host-cell")).toBe("context");
  });
  it("an agent drawn to a File Node is a plain link, not context", () => {
    expect(inferEdgeKind("agent", "file")).toBe("agent-link");
  });
});
