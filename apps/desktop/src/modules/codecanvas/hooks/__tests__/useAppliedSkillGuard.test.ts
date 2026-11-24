import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useAppliedSkillGuard } from "../useAppliedSkillGuard";

describe("useAppliedSkillGuard", () => {
  it("marks a skill applied for one terminal without affecting another", () => {
    const { result } = renderHook(() => useAppliedSkillGuard());
    act(() => result.current.markApplied("term-1", "ship"));
    expect(result.current.isApplied("term-1", "ship")).toBe(true);
    expect(result.current.isApplied("term-2", "ship")).toBe(false);
  });

  it("clearApplied re-enables a previously applied skill", () => {
    const { result } = renderHook(() => useAppliedSkillGuard());
    act(() => result.current.markApplied("term-1", "ship"));
    act(() => result.current.clearApplied("term-1", "ship"));
    expect(result.current.isApplied("term-1", "ship")).toBe(false);
  });

  it("listApplied returns every skill applied to a node, empty for unknown nodes", () => {
    const { result } = renderHook(() => useAppliedSkillGuard());
    expect(result.current.listApplied("agent-1")).toEqual([]);
    act(() => {
      result.current.markApplied("agent-1", "tdd");
      result.current.markApplied("agent-1", "review");
    });
    expect(result.current.listApplied("agent-1")).toEqual(["tdd", "review"]);
  });

  it("resetTerminal clears all skills for one terminal, leaving others intact", () => {
    const { result } = renderHook(() => useAppliedSkillGuard());
    act(() => {
      result.current.markApplied("term-1", "ship");
      result.current.markApplied("term-1", "tier2");
      result.current.markApplied("term-2", "ship");
    });
    act(() => result.current.resetTerminal("term-1"));
    expect(result.current.isApplied("term-1", "ship")).toBe(false);
    expect(result.current.isApplied("term-1", "tier2")).toBe(false);
    expect(result.current.isApplied("term-2", "ship")).toBe(true);
  });
});
