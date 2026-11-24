/**
 * Spawn-depth lineage for agent-driven spawns on the canvas.
 *
 * An agent can call `lotus_spawn_cell`, and so can the agent it creates. Without a ceiling that
 * recursion has no floor — each generation opens another PTY and another CLI process. Claude Code
 * settled on a depth limit for the same reason (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, default 3
 * since 2.1.219), and a depth limit is the honest one: it bounds the *chain*, where a session total
 * only bounds the crowd.
 *
 * The parent comes from `LOTUS_PANE_ID`, which every canvas PTY exports and the MCP sidecar already
 * forwards as `from_pane_id` on dispatch. Lineage is tracked by canvas node id, so it survives the
 * pane-id shape and needs no runtime lookup.
 *
 * Unknown parent means depth 0, deliberately: an agent the user spawned by hand has no recorded
 * lineage, and neither does a codespace cell. Failing open there costs one generation of slack;
 * failing closed would refuse the first spawn of every hand-made agent.
 */

/** Generations of agent-driven spawn allowed below a user-spawned agent. Mirrors Claude Code's default. */
export const MAX_SPAWN_DEPTH = 3;

/**
 * The canvas node id inside a pane id. Canvas panes are `canvas:<projectId>:<nodeId>` when a
 * project is open and a bare node id otherwise (see `canvasRuntimePaneId`). A node id may itself
 * contain colons, so only the first two segments are stripped.
 */
export function nodeIdFromPaneId(paneId: string | null | undefined): string | null {
  const trimmed = paneId?.trim();
  if (!trimmed) return null;
  const segments = trimmed.split(":");
  if (segments[0] === "canvas" && segments.length > 2) return segments.slice(2).join(":");
  return trimmed;
}

export interface SpawnDepthRegistry {
  /** Records a spawn and returns the child's depth. A null parent is a user spawn — depth 0. */
  record(childNodeId: string, parentNodeId: string | null): number;
  /** Generations between `nodeId` and the user who started the chain. */
  depthOf(nodeId: string): number;
  /** Whether a spawn by `parentNodeId` would land past {@link MAX_SPAWN_DEPTH}. */
  wouldExceed(parentNodeId: string | null): boolean;
  /** Forgets every lineage (project switch, or an explicit user reset). */
  reset(): void;
}

export function createSpawnDepthRegistry(max: number = MAX_SPAWN_DEPTH): SpawnDepthRegistry {
  const ceiling = Number.isFinite(max) && max >= 0 ? Math.floor(max) : MAX_SPAWN_DEPTH;
  const depths = new Map<string, number>();
  const depthOf = (nodeId: string) => depths.get(nodeId) ?? 0;
  return {
    record(childNodeId, parentNodeId) {
      const depth = parentNodeId ? depthOf(parentNodeId) + 1 : 0;
      depths.set(childNodeId, depth);
      return depth;
    },
    depthOf,
    wouldExceed(parentNodeId) {
      if (!parentNodeId) return false;
      return depthOf(parentNodeId) + 1 > ceiling;
    },
    reset() { depths.clear(); },
  };
}

/** Process-wide lineage shared by the MCP spawn bridge. */
export const mcpSpawnDepth: SpawnDepthRegistry = createSpawnDepthRegistry();

/** Message shown to the agent whose spawn was refused, so it stops retrying and reports instead. */
export function spawnDepthExceededMessage(parentDepth: number): string {
  return `Spawn refused — you are at depth ${parentDepth} and the canvas allows ${MAX_SPAWN_DEPTH} `
    + "generations of agent-driven spawn. Do the work yourself, reuse an existing agent, or ask the user.";
}
