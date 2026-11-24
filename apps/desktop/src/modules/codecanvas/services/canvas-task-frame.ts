import type { Node } from "@xyflow/react";
import { isFrameNode } from "./canvas-frames";

/**
 * Where a cell an agent spawns for one task lands (decision 30). Pure.
 *
 * Two or more cells for the same task share one Frame named after the task; a lone spawn stays
 * loose until a second arrives, which creates the Frame and pulls the first cell in. The Frame
 * carries `data.taskKey` (the task id) so later spawns find it again, also after a reload.
 * An explicit `frame` argument never reaches this: the caller skips the decision.
 */
export interface SpawnTask {
  id: string;
  title?: string | null;
}

export type TaskFrameDecision =
  | { kind: "none" }
  | { kind: "loose" }
  | { kind: "reuse"; frameId: string }
  | { kind: "create"; title: string; taskKey: string; pullNodeId: string };

export function decideTaskFrame(input: {
  nodes: readonly Node[];
  task: SpawnTask | undefined | null;
  /**
   * What the spawn bridge remembers of earlier spawns for this task. `fresh` = they happened moments
   * ago, so `nodes` (a React render behind) may not show them yet and the memory is trusted over it.
   */
  pending: { looseNodeId?: string; frameId?: string; fresh: boolean } | undefined;
}): TaskFrameDecision {
  const taskKey = input.task?.id?.trim();
  if (!taskKey) return { kind: "none" };

  const existing = input.nodes.find(
    (n) => isFrameNode(n) && (n.data as { taskKey?: unknown } | undefined)?.taskKey === taskKey,
  );
  if (existing) return { kind: "reuse", frameId: existing.id };

  const memory = input.pending;
  if (memory?.frameId && memory.fresh) return { kind: "reuse", frameId: memory.frameId };

  const looseId = memory?.looseNodeId;
  if (!looseId) return { kind: "loose" };
  const seen = input.nodes.find((n) => n.id === looseId && n.type !== "frame");
  const stillLoose = seen ? !(seen.data as { frameId?: unknown } | undefined)?.frameId : memory.fresh;
  if (!stillLoose) return { kind: "loose" };

  return { kind: "create", title: input.task?.title?.trim() || taskKey, taskKey, pullNodeId: looseId };
}
