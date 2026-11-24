import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentRunRegistration } from "../useAgentRunRegistration";
import { createAgentRunRegistry } from "../../services/agent-run-registry";
import type { AgentNodeStatus } from "../../types/canvas";

function setup(initial: AgentNodeStatus = "idle") {
  const reg = createAgentRunRegistry();
  const start = vi.fn();
  const seen: Array<[string, boolean]> = [];
  reg.subscribeResults((id, ok) => seen.push([id, ok]));
  const view = renderHook(
    ({ status }: { status: AgentNodeStatus }) => useAgentRunRegistration("a", status, start, reg),
    { initialProps: { status: initial } },
  );
  return { reg, start, seen, ...view };
}

describe("useAgentRunRegistration", () => {
  it("starts the node when the registry triggers a graph run", () => {
    const { reg, start } = setup();
    act(() => reg.run("a"));
    expect(start).toHaveBeenCalledOnce();
  });

  it("reports the result once the graph-driven run reaches a terminal status", () => {
    const { reg, seen, rerender } = setup();
    act(() => reg.run("a"));
    rerender({ status: "completed" });
    expect(seen).toEqual([["a", true]]);
  });

  it("does not report when the node finished outside a graph run", () => {
    const { seen, rerender } = setup();
    rerender({ status: "completed" }); // manual run, registry.run was never called
    expect(seen).toEqual([]);
  });

  it("passes the dispatch context to the node's start", () => {
    const reg = createAgentRunRegistry();
    const start = vi.fn();
    renderHook(() => useAgentRunRegistration("a", "idle", start, reg));
    act(() => reg.run("a", { graphRunId: "g1" }));
    expect(start).toHaveBeenCalledWith({ graphRunId: "g1" });
  });

  it("attaches the node's run result to the reported completion", () => {
    const reg = createAgentRunRegistry();
    const start = vi.fn();
    const result = { outcome: "completed" as const, sessionId: "s", nodeRunId: "r1" };
    const seen: unknown[] = [];
    reg.subscribeResults((id, ok, r) => seen.push([id, ok, r]));
    const { rerender } = renderHook(
      ({ status }: { status: AgentNodeStatus }) =>
        useAgentRunRegistration("a", status, start, reg, () => result),
      { initialProps: { status: "idle" as AgentNodeStatus } },
    );
    act(() => reg.run("a", { graphRunId: "g1" }));
    rerender({ status: "completed" });
    expect(seen).toEqual([["a", true, result]]);
  });
});
