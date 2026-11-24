import type { Node } from "@xyflow/react";
import { isWindowNode } from "./canvas-frame-target";
import { frameMembers, framesInOrder } from "./canvas-frames";
import { shouldTidyOnMutation, type TidyDecisionFlags, type TidyKind } from "./canvas-tidy-trigger";

/**
 * Decision 39: a member added to or closed in a Frame re-tiles that Frame and nothing re-frames the whole
 * canvas. Decision 47: with auto-tidy on (Settings → Canvas), an open or close in the active Frame refills the
 * screen with it, camera included; anywhere else, or with it off, the camera never moves. Pure planning,
 * so "focused" and the tidy gate are testable without a canvas. The hook (`useCanvasFrameFocus`) owns
 * timers and the camera.
 */

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** The last Frame the camera was flown to (decision 35), and where that put the camera. */
export interface FrameFocusRecord {
  frameId: string;
  /** Where the focus placed the camera. Null until a glide whose target is unknown settles. */
  viewport: Viewport | null;
  /** `performance.now()`-style time at which the glide ends. `Infinity` while unknown. */
  settledAt: number;
}

/** Screen px of pan, and fractional zoom change, below which the camera still counts as "on the Frame". */
export const FOCUS_PAN_TOLERANCE = 48;
export const FOCUS_ZOOM_TOLERANCE = 0.06;

/**
 * "Focused" = the camera is still where focusing the Frame put it. A pan, a zoom or Frame Overview
 * (which zooms far out) moves it past the tolerance and the Frame stops counting as focused.
 */
export function isFrameFocused(focus: FrameFocusRecord | null, viewport: Viewport): boolean {
  if (!focus?.viewport) return false;
  const t = focus.viewport;
  return (
    Math.abs(viewport.x - t.x) <= FOCUS_PAN_TOLERANCE &&
    Math.abs(viewport.y - t.y) <= FOCUS_PAN_TOLERANCE &&
    Math.abs(viewport.zoom - t.zoom) <= t.zoom * FOCUS_ZOOM_TOLERANCE
  );
}

/** Why a member change was announced: a node opened in, or closed out of, the Frame. */
export interface RetileIntent {
  kind: TidyKind;
  isNote: boolean;
}

export type RetilePlan =
  | { mode: "skip" }
  | { mode: "wait"; ms: number }
  | { mode: "focused"; frameId: string }
  | { mode: "in-box"; frameId: string };

export function planFrameRetile(input: {
  frameId: string;
  nodes: readonly Node[];
  focus: FrameFocusRecord | null;
  viewport: Viewport;
  /** Node-focus mode (hero + rail) is active: it re-tiles itself. */
  nodeFocused: boolean;
  now: number;
  /** What changed. Absent = unknown, which never counts as a tidy. */
  intent?: RetileIntent | null;
  /** Settings → Canvas auto-tidy switches. Absent = all off. */
  flags?: TidyDecisionFlags;
  /** The canvas's active Frame. */
  activeFrameId?: string | null;
  /** Frame Overview is open: the user is looking at every Frame, so the tidy never flies the camera in. */
  overviewOpen?: boolean;
}): RetilePlan {
  const { frameId, nodes, focus, viewport, nodeFocused, now, intent, flags, activeFrameId, overviewOpen } = input;
  if (nodeFocused) return { mode: "skip" };
  if (!framesInOrder(nodes).some((f) => f.id === frameId)) return { mode: "skip" };
  // Closing the last member leaves an empty Frame where it is, and the camera where it is.
  if (!frameMembers(nodes, frameId).some(isWindowNode)) return { mode: "skip" };
  const onThisFrame = focus?.frameId === frameId;
  // Do not re-tile through a running focus glide: the camera target would be stale the moment it lands.
  if (onThisFrame && now < focus.settledAt && Number.isFinite(focus.settledAt)) return { mode: "wait", ms: focus.settledAt - now };
  // Auto-tidy on (the default): what "arrange after open/close" was before Frames, scoped to the active Frame (the
  // one the user works in, where their new nodes go): an open or close there refills the screen with it, never
  // the canvas. A change in another Frame (an agent's, a node opened by name elsewhere) re-tiles in its box: it
  // neither moves the camera nor takes "active" away from the user's Frame.
  const tidy = !overviewOpen && Boolean(intent && flags && shouldTidyOnMutation(intent.kind, intent.isNote, flags));
  if (tidy && frameId === activeFrameId) return { mode: "focused", frameId };
  if (onThisFrame && isFrameFocused(focus, viewport)) return { mode: "focused", frameId };
  return { mode: "in-box", frameId };
}

export type MutationTidyAction = "refresh-focus" | "arrange-all" | "none";

/**
 * What the debounced create/close tidy (Settings → Canvas) may do. Node-focus mode refreshes its own
 * layout. Once the canvas has any Frame, the whole-canvas arrange (which also reframes the camera) is
 * off the table: members re-tile through {@link planFrameRetile} instead (root cause of "closing a
 * node zooms out"). With no Frame the existing tidy settings apply unchanged.
 */
export function decideMutationTidy(input: {
  kind: TidyKind;
  isNote: boolean;
  flags: TidyDecisionFlags;
  nodeFocused: boolean;
  nodes: readonly Node[];
}): MutationTidyAction {
  if (input.nodeFocused) return "refresh-focus";
  if (framesInOrder(input.nodes).length > 0) return "none";
  return shouldTidyOnMutation(input.kind, input.isNote, input.flags) ? "arrange-all" : "none";
}
