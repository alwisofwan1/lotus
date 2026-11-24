import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCanvasTaskDispatch } from "../useCanvasTaskDispatch";
import type { AgentRunRegistry, AgentResultListener } from "../../services/agent-run-registry";

function fakeRegistry() {
  const ran: string[] = [];
  let listener: AgentResultListener | null = null;
  const registry: AgentRunRegistry = {
    register: () => () => {},
    has: () => true,
    run: (id) => { ran.push(id); return true; },
    reportResult: (id, ok) => listener?.(id, ok),
    subscribeResults: (l) => { listener = l; return () => { listener = null; }; },
  };
  return { registry, ran, fire: (id: string) => listener?.(id, true) };
}

describe("useCanvasTaskDispatch", () => {
  it("runs a single agent immediately", () => {
    const reg = fakeRegistry();
    const { result } = renderHook(() => useCanvasTaskDispatch(reg.registry));
    act(() => result.current.schedule({ agentIds: ["solo"], deps: [] }));
    expect(reg.ran).toEqual(["solo"]);
  });

  it("runs the lead first, then releases the dependent on completion", () => {
    const reg = fakeRegistry();
    const { result } = renderHook(() => useCanvasTaskDispatch(reg.registry));
    act(() => result.current.schedule({ agentIds: ["lead", "be"], deps: [{ from: "lead", to: "be" }] }));
    expect(reg.ran).toEqual(["lead"]);
    act(() => reg.fire("lead"));
    expect(reg.ran).toEqual(["lead", "be"]);
  });

  it("ignores an empty dispatch", () => {
    const reg = fakeRegistry();
    const { result } = renderHook(() => useCanvasTaskDispatch(reg.registry));
    act(() => result.current.schedule({ agentIds: [], deps: [] }));
    expect(reg.ran).toEqual([]);
  });
});
