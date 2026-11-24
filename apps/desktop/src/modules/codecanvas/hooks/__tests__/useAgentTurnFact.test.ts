import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAgentAnsweredAt, useAgentTurnFact } from "../useAgentTurnFact";
import { createAgentTurnRegistry } from "../../services/agent-turn-registry";

describe("useAgentTurnFact", () => {
  it("returns nothing for a pane no hook has spoken for", () => {
    const registry = createAgentTurnRegistry();

    const { result } = renderHook(() => useAgentTurnFact("p-1", registry));

    expect(result.current).toBeUndefined();
  });

  it("returns the pane's own fact and ignores its neighbours", () => {
    const registry = createAgentTurnRegistry();
    registry.record({ paneId: "p-1", turn: "needs-input", atMs: 1_000 });
    registry.record({ paneId: "p-2", turn: "running", atMs: 1_000 });

    const { result } = renderHook(() => useAgentTurnFact("p-1", registry));

    expect(result.current?.turn).toBe("needs-input");
  });

  it("re-renders when a fact lands for its pane after mount", () => {
    // The whole point: a node mounted before its agent blocked must notice when it does. No
    // further hook will fire once the agent is waiting, so a missed update is a permanent one.
    const registry = createAgentTurnRegistry();
    const { result } = renderHook(() => useAgentTurnFact("p-1", registry));

    act(() => registry.record({ paneId: "p-1", turn: "needs-input", atMs: 2_000 }));

    expect(result.current?.turn).toBe("needs-input");
  });

  it("goes back to nothing when its pane is cleared", () => {
    const registry = createAgentTurnRegistry();
    registry.record({ paneId: "p-1", turn: "needs-input", atMs: 1_000 });
    const { result } = renderHook(() => useAgentTurnFact("p-1", registry));

    act(() => registry.clear("p-1"));

    expect(result.current).toBeUndefined();
  });

  it("stops listening on unmount", () => {
    // A node unmounts on every project switch. A listener left behind would write into a dead
    // component on the next hook event, and boards get switched a lot.
    const registry = createAgentTurnRegistry();
    const { unmount } = renderHook(() => useAgentTurnFact("p-1", registry));

    unmount();

    expect(() => registry.record({ paneId: "p-1", turn: "running", atMs: 1 })).not.toThrow();
  });
});

describe("useAgentAnsweredAt", () => {
  it("returns nothing before a human has acted", () => {
    const registry = createAgentTurnRegistry();

    const { result } = renderHook(() => useAgentAnsweredAt("p-1", registry));

    expect(result.current).toBeUndefined();
  });

  it("re-renders when a human answers, which the fact subscription alone cannot do", () => {
    // The gap this closes: `noteAnswered` leaves the FACT object untouched, so
    // `useAgentTurnFact`'s snapshot is reference-identical and React skips the render. The mark
    // would be recorded and the badge would keep saying needs-you until something unrelated
    // re-rendered the node.
    const registry = createAgentTurnRegistry();
    registry.record({ paneId: "p-1", turn: "needs-input", atMs: 1_000 });
    const { result } = renderHook(() => useAgentAnsweredAt("p-1", registry));

    act(() => registry.noteAnswered("p-1", 2_000));

    expect(result.current).toBe(2_000);
  });

  it("tracks only its own pane", () => {
    const registry = createAgentTurnRegistry();
    const { result } = renderHook(() => useAgentAnsweredAt("p-1", registry));

    act(() => registry.noteAnswered("p-2", 2_000));

    expect(result.current).toBeUndefined();
  });

  it("forgets the mark when the pane is cleared", () => {
    const registry = createAgentTurnRegistry();
    registry.noteAnswered("p-1", 2_000);
    const { result } = renderHook(() => useAgentAnsweredAt("p-1", registry));

    act(() => registry.clear("p-1"));

    expect(result.current).toBeUndefined();
  });
});
