import { act, renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useAgentCompletionToasts } from "../useAgentCompletionToasts";
import { SAME_PROJECT_DURATION_MS, type CompletionToast } from "../../services/agent-completion-toast";

function toast(id: string, dedupeKey: string): CompletionToast {
  return {
    id,
    dedupeKey,
    agentId: dedupeKey,
    agentName: "Nara",
    agentProjectId: undefined,
    projectLabel: null,
    scope: "same",
    durationMs: SAME_PROJECT_DURATION_MS,
    createdAt: 0,
  };
}

describe("useAgentCompletionToasts", () => {
  it("pushes toasts and exposes a stack view", () => {
    const { result } = renderHook(() => useAgentCompletionToasts());
    act(() => result.current.push(toast("a", "k1")));
    expect(result.current.toasts.map((t) => t.id)).toEqual(["a"]);
    expect(result.current.view.visible.map((t) => t.id)).toEqual(["a"]);
  });

  it("de-dupes by key (latest-wins) so a re-firing agent updates in place", () => {
    const { result } = renderHook(() => useAgentCompletionToasts());
    act(() => result.current.push(toast("a", "k1")));
    act(() => result.current.push(toast("b", "k2")));
    act(() => result.current.push(toast("a2", "k1")));
    expect(result.current.toasts.map((t) => t.id)).toEqual(["b", "a2"]);
  });

  it("dismisses a single toast by id", () => {
    const { result } = renderHook(() => useAgentCompletionToasts());
    act(() => result.current.push(toast("a", "k1")));
    act(() => result.current.push(toast("b", "k2")));
    act(() => result.current.dismiss("a"));
    expect(result.current.toasts.map((t) => t.id)).toEqual(["b"]);
  });

  it("clears all toasts", () => {
    const { result } = renderHook(() => useAgentCompletionToasts());
    act(() => result.current.push(toast("a", "k1")));
    act(() => result.current.push(toast("b", "k2")));
    act(() => result.current.clear());
    expect(result.current.toasts).toEqual([]);
  });

  it("collapses beyond the cap into a pile", () => {
    const { result } = renderHook(() => useAgentCompletionToasts({ maxVisible: 2 }));
    act(() => {
      result.current.push(toast("a", "k1"));
      result.current.push(toast("b", "k2"));
      result.current.push(toast("c", "k3"));
    });
    expect(result.current.view.visible.map((t) => t.id)).toEqual(["c"]);
    expect(result.current.view.collapsedCount).toBe(2);
  });
});
