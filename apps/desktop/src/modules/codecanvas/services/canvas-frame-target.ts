import type { Node } from "@xyflow/react";
import { isTiledCanvasNode } from "./canvas-arrange";
import { resolveActiveFrameId } from "./canvas-active-frame";
import {
  canCreateFrame,
  frameIdOf,
  framesInOrder,
  nextFrameTitle,
  placeInTargetFrame,
  tryCreateFrameFromSelection,
} from "./canvas-frames";

/**
 * Where a NEW node goes (decisions 37 and 38). Every create path funnels through
 * {@link placeNewWindowNode}; {@link decideNewNodeFrame} is the one place the target is decided.
 * Pure: the caller supplies the active Frame id (from the store) and any explicit hints.
 */

/** A window node: terminal, agent, browser, note, task… Not a shape/drawing/image, not a Frame, not ephemeral. */
export const isWindowNode = (node: Node): boolean => isTiledCanvasNode(node) && canCreateFrame([node]);

export interface NewNodeFrameHints {
  /** The canvas's active Frame (may be stale or null; it is validated here). */
  activeFrameId: string | null;
  /** A Frame named by the caller (Frame "+", MCP `frame`): wins over everything. */
  explicitFrameId?: string | null;
  /** The spawn belongs to a Lotus task: the task grouping decides, so no active-Frame default. */
  hasTask?: boolean;
}

export type NewNodeFrameDecision =
  | { kind: "loose" }
  | { kind: "join"; frameId: string }
  | { kind: "create" };

export function decideNewNodeFrame(nodes: readonly Node[], node: Node, hints: NewNodeFrameHints): NewNodeFrameDecision {
  // A node that already carries a Frame (restore, programmatic placement) and anything that is not a
  // window (shapes, drawings, images stay where they are drawn) is never re-homed.
  if (frameIdOf(node) || !isWindowNode(node)) return { kind: "loose" };
  const frames = framesInOrder(nodes);
  const explicit = hints.explicitFrameId;
  if (explicit && frames.some((f) => f.id === explicit)) return { kind: "join", frameId: explicit };
  if (hints.hasTask) return { kind: "loose" };
  const active = resolveActiveFrameId(nodes, hints.activeFrameId);
  if (active) return { kind: "join", frameId: active };
  return { kind: "create" };
}

export interface NewNodePlacement {
  nodes: Node[];
  /** The Frame the node ended up in, if any. */
  frameId?: string;
  /** That Frame was created for this node (decision 37). */
  createdFrame?: boolean;
}

/** `node` appended to `nodes`, in the Frame {@link decideNewNodeFrame} picks. Never moves other nodes. */
export function placeNewWindowNode(nodes: readonly Node[], node: Node, hints: NewNodeFrameHints): NewNodePlacement {
  const decision = decideNewNodeFrame(nodes, node, hints);
  if (decision.kind === "join") {
    return { nodes: placeInTargetFrame(nodes, node, decision.frameId), frameId: decision.frameId };
  }
  if (decision.kind === "create") {
    const appended = [...nodes, node];
    // No Frame left (the last one was deleted or dissolved): windows still loose join Frame 1 with the newcomer,
    // as opening the canvas would do (decision 37), instead of staying loose for good.
    const ids = appended.filter((n) => isWindowNode(n) && !frameIdOf(n)).map((n) => n.id);
    const r = tryCreateFrameFromSelection(appended, ids, autoFrameId(node.id), { title: nextFrameTitle(nodes) });
    if (r.ok) return { nodes: r.nodes, frameId: r.frameId, createdFrame: true };
    return { nodes: appended };
  }
  return { nodes: [...nodes, node] };
}

/** Deterministic, so reloading an unsaved auto Frame yields the same id (and the saved active id still matches). */
const autoFrameId = (firstMemberId: string) => `frame-auto-${firstMemberId}`;

/**
 * Opening a canvas with no Frame wraps its loose window nodes in "Frame 1" (decision 37): fit, padding
 * 0, no toast. Same array back when there is nothing to do.
 */
export function wrapLooseWindowsInFrame(nodes: Node[]): Node[] {
  if (framesInOrder(nodes).length > 0) return nodes;
  const loose = nodes.filter((n) => isWindowNode(n) && !frameIdOf(n));
  if (loose.length === 0) return nodes;
  const r = tryCreateFrameFromSelection(nodes, loose.map((n) => n.id), autoFrameId(loose[0].id), { title: nextFrameTitle(nodes) });
  return r.ok ? r.nodes : nodes;
}
