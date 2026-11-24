import { canvasRuntimeScope, projectIdFromCanvasScope } from "./canvas-runtime-scope";

/**
 * Where a remote spawn request should land, decided before any node is created.
 *
 * **The bug this replaces.** `mcp://spawn-cell` has carried `workspaceId` since the phone
 * could ask for one, and every layer forwarded it faithfully — Pocket, the host façade,
 * Rust. The canvas bridge then declared it in its payload type and never read it, so the
 * node was created on whichever board happened to be mounted. An operator who switched
 * Pocket to `codespace-demo` and started an agent got one in `Lotus`, with nothing on
 * either screen saying the request had been redirected.
 *
 * The codespace bridge got this right — it guards on `payload.workspaceId` — so the two
 * routes disagreed about the same event. That is why this is a shared, tested function
 * rather than a third hand-rolled `if`.
 */
export type SpawnTarget =
  /** The board on screen is the one asked for, or none was asked for. */
  | { kind: "spawn-here" }
  /** Asked for a different project this window knows; switch the board first. */
  | { kind: "switch-first"; projectId: string; workspaceId: string }
  /** Asked for something this window cannot open. Refuse rather than substitute. */
  | { kind: "refuse"; reason: string };

/**
 * @param requested `workspaceId` from the spawn payload — `canvas:<projectId>`.
 * @param activeProjectId the project whose board is mounted right now.
 * @param knownProjectIds every project this window can switch to.
 */
export function decideSpawnTarget(
  requested: string | null | undefined,
  activeProjectId: string | null | undefined,
  knownProjectIds: readonly string[],
): SpawnTarget {
  const asked = requested?.trim();
  // No workspace named: every caller before the phone worked this way, and reading an
  // absent field as "refuse" would break agent-to-agent spawns that never named one.
  if (!asked) return { kind: "spawn-here" };

  if (activeProjectId && asked === canvasRuntimeScope(activeProjectId)) {
    return { kind: "spawn-here" };
  }

  const projectId = projectIdFromCanvasScope(asked);
  if (projectId === null) {
    // A codespace or swarm workspace id reaching the canvas bridge is not a project this
    // board can open, and silently using the current one is the exact bug above.
    return {
      kind: "refuse",
      reason: `\`${asked}\` is not a canvas project this window can open.`,
    };
  }

  if (!knownProjectIds.includes(projectId)) {
    // Named honestly: a phone holding a project the desktop has since closed is the
    // common way here, and "not open on this machine" is the sentence that explains it.
    return {
      kind: "refuse",
      reason: `Project \`${projectId}\` is not open on this machine.`,
    };
  }

  return { kind: "switch-first", projectId, workspaceId: asked };
}
