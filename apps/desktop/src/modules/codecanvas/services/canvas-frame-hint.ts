import type { Node } from "@xyflow/react";

/** Session-only nodes and annotations are not "work", so they never count toward the hint. */
const NOT_WORK = new Set(["frame", "shape", "skill", "skills"]);

export const FIRST_FRAME_HINT_MIN_NODES = 3;
export const FIRST_FRAME_HINT_KEY = "lotus.canvas.firstFrameHintSeen";

/** Decision 22: once, when >= 3 loose nodes exist and the canvas has no Frame yet. */
export function shouldShowFirstFrameHint(nodes: readonly Node[], seen: boolean): boolean {
  if (seen) return false;
  if (nodes.some((n) => n.type === "frame")) return false;
  return nodes.filter((n) => !NOT_WORK.has(n.type ?? "")).length >= FIRST_FRAME_HINT_MIN_NODES;
}

export function readFirstFrameHintSeen(): boolean {
  try {
    return window.localStorage.getItem(FIRST_FRAME_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function markFirstFrameHintSeen(): void {
  try {
    window.localStorage.setItem(FIRST_FRAME_HINT_KEY, "1");
  } catch {
    /* private window or blocked storage: the hint just may show again */
  }
}
