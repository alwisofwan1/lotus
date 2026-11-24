import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNeedsYouQueue, NEEDS_YOU_TICK_MS } from "../useNeedsYouQueue";
import { createAgentTurnRegistry } from "../../services/agent-turn-registry";
import type { AgentStatusSnapshot } from "../../services/agent-status-registry";

const agent = (id: string, name: string, status: AgentStatusSnapshot["status"]): AgentStatusSnapshot => ({
  id,
  name,
  status,
  hookPaneId: `canvas:cp_1:${id}`,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useNeedsYouQueue", () => {
  it("returns the blocked agents, longest wait first", () => {
    const turns = createAgentTurnRegistry();
    turns.record({ paneId: "canvas:cp_1:a1", turn: "needs-input", atMs: Date.now() - 90_000 });
    turns.record({ paneId: "canvas:cp_1:a2", turn: "needs-input", atMs: Date.now() - 5_000 });

    const { result } = renderHook(() =>
      useNeedsYouQueue([agent("a2", "Mira", "needs-you"), agent("a1", "Atlas", "needs-you")], turns),
    );

    expect(result.current.map((e) => e.name)).toEqual(["Atlas", "Mira"]);
  });

  it("keeps the ages moving while something is waiting", () => {
    // Without a tick the wait freezes at whatever it was when the row mounted, and a stale "0s" on
    // a prompt that has been open for ten minutes is worse than showing nothing.
    const turns = createAgentTurnRegistry();
    turns.record({ paneId: "canvas:cp_1:a1", turn: "needs-input", atMs: Date.now() });

    const { result } = renderHook(() => useNeedsYouQueue([agent("a1", "Atlas", "needs-you")], turns));
    const first = result.current[0].waitingMs ?? 0;

    act(() => void vi.advanceTimersByTime(NEEDS_YOU_TICK_MS + 50));

    expect((result.current[0].waitingMs ?? 0) - first).toBeGreaterThanOrEqual(NEEDS_YOU_TICK_MS);
  });

  it("runs no timer at all when nothing is waiting", () => {
    // The lane is empty most of the day on most boards. A ticker running behind an empty strip is
    // pure cost, and this panel already re-renders on every node change.
    const turns = createAgentTurnRegistry();
    renderHook(() => useNeedsYouQueue([agent("a1", "Atlas", "running")], turns));

    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops its timer on unmount", () => {
    const turns = createAgentTurnRegistry();
    turns.record({ paneId: "canvas:cp_1:a1", turn: "needs-input", atMs: Date.now() });

    const { unmount } = renderHook(() => useNeedsYouQueue([agent("a1", "Atlas", "needs-you")], turns));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("picks up a fact that lands after mount", () => {
    // A node can publish `needs-you` a beat before or after its turn fact reaches the registry.
    const turns = createAgentTurnRegistry();
    const { result } = renderHook(() => useNeedsYouQueue([agent("a1", "Atlas", "needs-you")], turns));

    expect(result.current[0].waitingMs).toBeUndefined();
    act(() => turns.record({ paneId: "canvas:cp_1:a1", turn: "needs-input", atMs: Date.now() - 3_000 }));

    expect(result.current[0].waitingMs).toBeGreaterThanOrEqual(3_000);
  });
});
