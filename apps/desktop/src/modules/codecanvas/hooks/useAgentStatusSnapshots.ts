"use client";

import { useEffect, useState } from "react";
import {
  agentStatusRegistry,
  type AgentStatusRegistry,
  type AgentStatusSnapshot,
} from "../services/agent-status-registry";

/**
 * The live agent roster, kept current.
 *
 * Lifted out of `CanvasRightSidebar` when that panel was deleted
 * (`plans/canvas-fleet-panel/` R4) — the fleet rail needs the same list, and a second private copy
 * of a four-line subscription is how two views start disagreeing about who is on the board.
 *
 * The registry is injectable for the same reason the stores around it are: a component test should
 * be able to drive a roster without reaching into process-wide state that outlives it.
 */
export function useAgentStatusSnapshots(
  registry: AgentStatusRegistry = agentStatusRegistry,
): AgentStatusSnapshot[] {
  const [snapshots, setSnapshots] = useState<AgentStatusSnapshot[]>(() => registry.list());
  // Subscribe only — no synchronous re-read. The initializer already holds the current roster, and
  // setting state inside the effect body cascades a second render on every mount for a value that
  // is, by construction, the one we just read. `useSyncExternalStore` is not the alternative here:
  // `list()` allocates a fresh array per call, so it has no stable snapshot to compare.
  useEffect(() => registry.subscribe(setSnapshots), [registry]);
  return snapshots;
}
