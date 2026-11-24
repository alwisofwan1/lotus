import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { resolveCanvasControlTarget } from "../canvas-control-target";
import type { AgentStatusSnapshot } from "../agent-status-registry";

const node = (id: string, title?: string): Node => ({
  id,
  position: { x: 0, y: 0 },
  data: title ? { title } : {},
  type: "agent",
});

const roster: AgentStatusSnapshot[] = [{ id: "agent-1", name: "Sage", status: "idle" } as AgentStatusSnapshot];

describe("resolveCanvasControlTarget", () => {
  const nodes = [node("agent-1", "Sage"), node("term-9", "Build terminal")];

  it("resolves an exact node id", () => {
    expect(resolveCanvasControlTarget("term-9", nodes, roster)).toEqual({ ok: true, nodeId: "term-9" });
  });

  it("resolves an agent name via the roster to its node id", () => {
    expect(resolveCanvasControlTarget("Sage", nodes, roster)).toEqual({ ok: true, nodeId: "agent-1" });
  });

  it("resolves a node by exact title (case-insensitive)", () => {
    expect(resolveCanvasControlTarget("build terminal", nodes, roster)).toEqual({ ok: true, nodeId: "term-9" });
  });

  it("resolves a node by title substring", () => {
    expect(resolveCanvasControlTarget("terminal", nodes, roster)).toEqual({ ok: true, nodeId: "term-9" });
  });

  it("rejects an empty target", () => {
    expect(resolveCanvasControlTarget("  ", nodes, roster).ok).toBe(false);
  });

  it("rejects an unknown target with a helpful error", () => {
    const res = resolveCanvasControlTarget("nope", nodes, roster);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nope");
  });

  it("does not resolve a roster id that has no matching node", () => {
    // roster knows agent-1, but if it's not on the board the focus must fail.
    expect(resolveCanvasControlTarget("agent-1", [node("other")], roster).ok).toBe(false);
  });
});
