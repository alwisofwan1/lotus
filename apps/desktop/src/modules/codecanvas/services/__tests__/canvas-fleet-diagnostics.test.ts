import { describe, expect, it } from "vitest";
import { computeCanvasFleetDebugSnapshot, formatCanvasFleetDiagnostics, logCanvasFleetDiagnostics } from "../canvas-fleet-diagnostics";
import type { AgentStatusSnapshot } from "../agent-status-registry";

const reg = (id: string, name: string, status: AgentStatusSnapshot["status"]): AgentStatusSnapshot => ({ id, name, status });

describe("computeCanvasFleetDebugSnapshot — Phase 0 observability", () => {
  it("flags a visible node that never made it into the pushed MCP fleet", () => {
    const snap = computeCanvasFleetDebugSnapshot({
      agentNodes: [{ id: "node-nova", name: "Nova" }],
      registry: [],
      replyHandleIds: [],
      replyReadyIds: [],
      pushedFleetNodeIds: [], // Nova is on the board but absent from the fleet
    });
    const nova = snap.agents.find((a) => a.id === "node-nova")!;
    expect(nova.visible).toBe(true);
    expect(nova.inPushedFleet).toBe(false);
    expect(nova.reason).toBe("Nova visible but missing from MCP fleet");
    expect(snap.problems).toContain("Nova visible but missing from MCP fleet");
  });

  it("flags a fleet member with no reply handle", () => {
    const snap = computeCanvasFleetDebugSnapshot({
      agentNodes: [{ id: "node-nova", name: "Nova" }],
      registry: [reg("node-nova", "Nova", "running")],
      replyHandleIds: [],
      replyReadyIds: [],
      pushedFleetNodeIds: ["node-nova"],
    });
    expect(snap.agents[0].reason).toBe("Nova in fleet but no reply handle");
  });

  it("flags a reply handle that exists but is not ready (queued)", () => {
    const snap = computeCanvasFleetDebugSnapshot({
      agentNodes: [{ id: "node-nova", name: "Nova" }],
      registry: [reg("node-nova", "Nova", "connecting")],
      replyHandleIds: ["node-nova"],
      replyReadyIds: [], // handle registered but canReply() false
      pushedFleetNodeIds: ["node-nova"],
    });
    expect(snap.agents[0].reason).toBe("Nova reply handle exists but not ready, queued");
  });

  it("reports ok and no problems when everything lines up", () => {
    const snap = computeCanvasFleetDebugSnapshot({
      agentNodes: [{ id: "node-nova", name: "Nova" }],
      registry: [reg("node-nova", "Nova", "running")],
      replyHandleIds: ["node-nova"],
      replyReadyIds: ["node-nova"],
      pushedFleetNodeIds: ["node-nova"],
    });
    expect(snap.agents[0].reason).toBe("Nova ok");
    expect(snap.problems).toEqual([]);
  });

  it("surfaces counts, profile key, and stale age", () => {
    const snap = computeCanvasFleetDebugSnapshot({
      agentNodes: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      registry: [reg("a", "A", "running")],
      replyHandleIds: ["a"],
      replyReadyIds: ["a"],
      pushedFleetNodeIds: ["a"],
      profileKey: "lotus-dev",
      snapshotAgeMs: 1234,
    });
    expect(snap.counts).toEqual({ nodeAgents: 2, registry: 1, replyHandles: 1, pushedFleet: 1 });
    expect(snap.profileKey).toBe("lotus-dev");
    expect(snap.snapshotAgeMs).toBe(1234);
  });

  it("flags an orphan fleet entry that has no visible node backing it", () => {
    const snap = computeCanvasFleetDebugSnapshot({
      agentNodes: [],
      registry: [],
      replyHandleIds: [],
      replyReadyIds: [],
      pushedFleetNodeIds: ["ghost-node"], // in the fleet, but no on-board node
    });
    expect(snap.problems.some((p) => /ghost-node/.test(p) && /orphan|no visible node/i.test(p))).toBe(true);
  });
});

describe("formatCanvasFleetDiagnostics", () => {
  it("renders a compact, human-readable summary line-set", () => {
    const text = formatCanvasFleetDiagnostics(
      computeCanvasFleetDebugSnapshot({
        agentNodes: [{ id: "node-nova", name: "Nova" }],
        registry: [],
        replyHandleIds: [],
        replyReadyIds: [],
        pushedFleetNodeIds: [],
        profileKey: "lotus",
      }),
    );
    expect(text).toContain("Nova visible but missing from MCP fleet");
    expect(text).toContain("lotus");
  });
});

describe("logCanvasFleetDiagnostics — dev-gated logging", () => {
  const input = {
    agentNodes: [{ id: "node-nova", name: "Nova" }],
    registry: [],
    replyHandleIds: [],
    replyReadyIds: [],
    pushedFleetNodeIds: [],
  };

  it("logs the breakdown when enabled and returns the snapshot", () => {
    const calls: string[] = [];
    const snap = logCanvasFleetDiagnostics(input, { enabled: true, logger: { debug: (m: string) => calls.push(m) } });
    expect(calls.join("\n")).toContain("Nova visible but missing from MCP fleet");
    expect(snap.problems).toHaveLength(1);
  });

  it("stays silent when disabled but still returns the snapshot", () => {
    const calls: string[] = [];
    const snap = logCanvasFleetDiagnostics(input, { enabled: false, logger: { debug: (m: string) => calls.push(m) } });
    expect(calls).toEqual([]);
    expect(snap.agents).toHaveLength(1);
  });
});
