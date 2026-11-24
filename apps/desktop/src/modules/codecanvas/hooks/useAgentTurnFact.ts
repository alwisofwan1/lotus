"use client";

/**
 * One pane's turn fact, for the node that renders it (`plans/honest-agent-status/` Slice 3).
 *
 * The counterpart to {@link useAgentTurnFacts}: that hook owns the transport once per board, this
 * one is the cheap per-node reader. `useSyncExternalStore` rather than `useState` + `useEffect`,
 * because the registry is exactly the external store it exists for — it reads the current value
 * during render instead of one render behind, so a node that mounts after its agent blocked shows
 * `needs-you` on its first paint rather than flashing `running` first.
 *
 * The registry hands back the stored object itself, unchanged until a newer fact replaces it, so
 * the snapshot is reference-stable and this does not loop.
 */

import { useCallback, useSyncExternalStore } from "react";
import {
  agentTurnRegistry,
  type AgentTurnFact,
  type AgentTurnRegistry,
} from "../services/agent-turn-registry";

export function useAgentTurnFact(
  paneId: string,
  registry: AgentTurnRegistry = agentTurnRegistry,
): AgentTurnFact | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => registry.subscribe(onChange),
    [registry],
  );
  const getSnapshot = useCallback(() => registry.get(paneId), [registry, paneId]);
  // The server render has no registry, and a turn fact is live state by definition — there is
  // nothing to hydrate from, so the server snapshot is deliberately empty.
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/**
 * When a human last acted on this pane (`plans/honest-agent-status/` Slice 8).
 *
 * A sibling of {@link useAgentTurnFact} rather than part of it, because the two answer different
 * questions and — crucially — change at different times. `noteAnswered` leaves the FACT object
 * untouched, so that hook's snapshot stays reference-identical and React correctly skips the render.
 * Without this hook the mark would be recorded and the badge would keep saying `needs-you` until
 * something unrelated happened to re-render the node.
 *
 * A number is already primitive and stable, so it is a snapshot `useSyncExternalStore` can compare.
 */
export function useAgentAnsweredAt(
  paneId: string,
  registry: AgentTurnRegistry = agentTurnRegistry,
): number | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => registry.subscribe(onChange),
    [registry],
  );
  const getSnapshot = useCallback(() => registry.answeredAt(paneId), [registry, paneId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}
