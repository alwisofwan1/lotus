import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAgentTurnFacts } from "../useAgentTurnFacts";
import { createAgentTurnRegistry } from "../../services/agent-turn-registry";
import type { AgentTurnFact } from "../../services/agent-turn-registry";

/** A transport that records what it was asked and lets the test drive the push stream. */
function transport(snapshot: AgentTurnFact[] = []) {
  const asked: string[][] = [];
  let push: ((fact: AgentTurnFact) => void) | undefined;
  const unsubscribe = vi.fn();
  return {
    asked,
    unsubscribe,
    emit: (fact: AgentTurnFact) => push?.(fact),
    isSubscribed: () => push !== undefined,
    deps: {
      fetchTurns: async (paneIds: string[]) => {
        asked.push(paneIds);
        return snapshot;
      },
      subscribeTurns: (onTurn: (fact: AgentTurnFact) => void) => {
        push = onTurn;
        return unsubscribe;
      },
    },
  };
}

describe("useAgentTurnFacts", () => {
  it("hydrates the registry with the facts Rust already held", async () => {
    const registry = createAgentTurnRegistry();
    const t = transport([{ paneId: "p-1", turn: "needs-input", atMs: 1_000 }]);

    renderHook(() => useAgentTurnFacts(["p-1"], { ...t.deps, registry }));

    await vi.waitFor(() => expect(registry.get("p-1")?.turn).toBe("needs-input"));
    expect(t.asked).toEqual([["p-1"]]);
  });

  it("records facts pushed after mount", async () => {
    const registry = createAgentTurnRegistry();
    const t = transport();

    renderHook(() => useAgentTurnFacts(["p-1"], { ...t.deps, registry }));
    await vi.waitFor(() => expect(t.isSubscribed()).toBe(true));
    t.emit({ paneId: "p-1", turn: "needs-input", atMs: 2_000 });

    expect(registry.get("p-1")?.turn).toBe("needs-input");
  });

  it("drops the subscription on unmount", async () => {
    const registry = createAgentTurnRegistry();
    const t = transport();

    const { unmount } = renderHook(() => useAgentTurnFacts(["p-1"], { ...t.deps, registry }));
    await vi.waitFor(() => expect(t.isSubscribed()).toBe(true));
    unmount();

    expect(t.unsubscribe).toHaveBeenCalled();
  });

  it("does not let a late hydrate overwrite a fact pushed while it was in flight", async () => {
    // The race this hook exists to survive. The hydrate is an await; a pane can block and push
    // `needs-input` before it resolves. If the older snapshot won, the badge would flip back to
    // `running` and stay wrong until the next hook — which, for a blocked agent, never comes.
    const registry = createAgentTurnRegistry();
    let release: ((facts: AgentTurnFact[]) => void) | undefined;
    const deps = {
      registry,
      fetchTurns: () => new Promise<AgentTurnFact[]>((resolve) => (release = resolve)),
      subscribeTurns: (onTurn: (fact: AgentTurnFact) => void) => {
        onTurn({ paneId: "p-1", turn: "needs-input", atMs: 2_000 });
        return () => {};
      },
    };

    renderHook(() => useAgentTurnFacts(["p-1"], deps));
    await vi.waitFor(() => expect(release).toBeDefined());
    release!([{ paneId: "p-1", turn: "running", atMs: 1_000 }]);

    await vi.waitFor(() => expect(registry.get("p-1")?.turn).toBe("needs-input"));
  });

  it("does not ask Rust anything when the board has no agents", async () => {
    const registry = createAgentTurnRegistry();
    const t = transport();

    renderHook(() => useAgentTurnFacts([], { ...t.deps, registry }));
    await vi.waitFor(() => expect(t.isSubscribed()).toBe(true));

    expect(t.asked).toEqual([]);
  });

  it("re-fetches only when the set of panes actually changes", async () => {
    // `paneIds` is derived from the node list, so it is a NEW array on every render. Keying the
    // effect on array identity would re-fetch on every keystroke that re-renders the board — one
    // IPC round-trip per render, forever. The set's contents are what matters, not its identity.
    const registry = createAgentTurnRegistry();
    const t = transport();

    const { rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useAgentTurnFacts(ids, { ...t.deps, registry }),
      { initialProps: { ids: ["p-1", "p-2"] } },
    );
    await vi.waitFor(() => expect(t.asked).toHaveLength(1));

    rerender({ ids: ["p-1", "p-2"] }); // same panes, fresh array
    rerender({ ids: ["p-2", "p-1"] }); // same panes, different order
    await Promise.resolve();
    expect(t.asked).toHaveLength(1);

    rerender({ ids: ["p-1", "p-2", "p-3"] }); // a node was added — now it must re-fetch
    await vi.waitFor(() => expect(t.asked).toHaveLength(2));
  });
});
