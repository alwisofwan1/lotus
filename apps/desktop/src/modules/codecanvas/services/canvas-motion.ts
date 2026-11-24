import { getCanvasBehaviorSettings } from "../hooks/useCanvasBehaviorSettings";

// Canvas motion tokens — the single source of truth for JS-driven canvas animation
// timing. CSS-driven motion reads the mirrored custom properties in
// src/styles/canvas/motion.css; keep the two in sync when tuning.
//
// Every JS tween (arrange glide, focus/zoom/fit viewport moves, close-leave delay)
// resolves its duration through {@link canvasMotionDuration} so ONE check — the
// user's "Smooth canvas animations" setting AND the OS prefers-reduced-motion —
// silences all of them. CSS motion is silenced by the same pair via the
// `data-canvas-motion="off"` shell attribute + the media query in motion.css.

/** Node glide during arrange/tidy (mirrors ARRANGE_ANIM_MS in canvas-arrange.ts). */
export const CANVAS_MOTION = {
  /** Pan/zoom to a focused node (fitView). */
  focusMs: 420,
  /** Zoom in/out button step. */
  zoomMs: 360,
  /** Fit-all reframe. */
  fitMs: 420,
  /** Reset viewport on an empty canvas. */
  resetMs: 340,
  /** Camera reframe after the arrange glide settles. */
  reframeMs: 620,
  /** Restore the persisted viewport when a project opens. */
  restoreMs: 300,
  /** Close-leave removal delay: CSS leave duration (260ms) + small anticipation delay (24ms) + safety. */
  leaveMs: 300,
  /** Node mount animation (mirrors --canvas-motion-enter in motion.css). */
  enterMs: 380,
  /** Anticipation pause before a node opens (mirrors --canvas-motion-enter-delay). */
  enterDelayMs: 48,
} as const;

/** Auto-tidy debounce after node create/close. Long enough that a batch of PTY nodes
 *  finishes its xterm mount spike BEFORE the arrange glide starts — gliding through
 *  that spike starves the rAF tween and the motion collapses into a teleport. */
export const TIDY_DEBOUNCE_MS = 760;

/** Stagger between nodes mounting in one burst ("open 3 agents" cascades in). */
export const ENTER_STAGGER_STEP_MS = 64;
/** Cap the enter cascade so a big batch doesn't crawl (slots beyond this share the last delay). */
export const ENTER_STAGGER_MAX_SLOTS = 8;
/** Two creations within this window count as the same burst. */
export const ENTER_BURST_WINDOW_MS = 400;
/** Per-node delay step for the close-all cascade… */
export const LEAVE_STAGGER_STEP_MS = 42;
/** …clamped so even a packed canvas finishes leaving within this envelope (+ leaveMs). */
export const LEAVE_STAGGER_MAX_TOTAL_MS = 320;

/** easeOutQuart — shared viewport easing (fast start, gentle settle). */
export const canvasEaseOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

/** easeOutQuint — slower final settle for premium camera zoom/focus moves. */
export const canvasEaseOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);

/**
 * Whether canvas motion should play at all: the user's "Smooth canvas animations"
 * setting AND the OS-level reduced-motion preference. Impure boundary (store +
 * matchMedia) — call at animation time, not at module load, so a settings change
 * applies to the very next action.
 */
export function canvasMotionEnabled(): boolean {
  if (!getCanvasBehaviorSettings().canvasAnimations) return false;
  if (typeof window === "undefined") return true;
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** A JS tween duration honoring the motion gate — 0 collapses the move to instant. */
export function canvasMotionDuration(ms: number): number {
  return canvasMotionEnabled() ? ms : 0;
}

/** How long the enter hold must last for a node whose stagger delay is `staggerMs`. */
export function canvasNodeEnterHoldMs(staggerMs: number): number {
  return CANVAS_MOTION.enterDelayMs + staggerMs + CANVAS_MOTION.enterMs + 80;
}

let nodeEnterHoldTimer: number | undefined;
let nodeEnterHoldUntil = 0;

/**
 * Suspend the per-node backdrop blur while a node plays its mount animation (rule in motion.css keyed
 * on `data-canvas-entering`). Same reasoning as {@link holdCanvasArrangeGlide}: the enter animates
 * transform+opacity on a backdrop-filtered glass panel, and re-blurring N panels every frame is what
 * starved a spawning Terminal/Agent node's own entrance. A burst extends the hold (latest end wins)
 * instead of the first node's timer unblurring mid-cascade. No-op when motion is off.
 */
export function holdCanvasNodeEnter(staggerMs: number): void {
  if (typeof document === "undefined" || !canvasMotionEnabled()) return;
  const shell = document.querySelector(".codecanvas-shell");
  if (!shell) return;
  const holdMs = canvasNodeEnterHoldMs(staggerMs);
  const end = performance.now() + holdMs;
  if (shell.hasAttribute("data-canvas-entering") && end <= nodeEnterHoldUntil) return;
  nodeEnterHoldUntil = end;
  shell.setAttribute("data-canvas-entering", "true");
  window.clearTimeout(nodeEnterHoldTimer);
  nodeEnterHoldTimer = window.setTimeout(() => {
    nodeEnterHoldUntil = 0;
    shell.removeAttribute("data-canvas-entering");
  }, holdMs);
}

/** Safety net only. A drag that never reports its end must not strand the canvas unblurred. */
const DRAG_HOLD_WATCHDOG_MS = 30_000;
let dragHoldWatchdog: number | undefined;

/**
 * Suspend the per-node backdrop blur for the duration of a pointer drag (rule in motion.css keyed
 * on `data-canvas-dragging`). Bracketed by ReactFlow's `onNodeDragStart`/`onNodeDragStop`.
 *
 * Same economics as {@link holdCanvasArrangeGlide} and {@link holdCanvasNodeEnter}: re-blurring N
 * glass panels per frame is the most expensive part of moving a node in WKWebView. Drag was the one
 * motion that never got the relief, and it is the one the user feels most directly — their hand is
 * on it, so every dropped frame reads as the canvas sticking.
 *
 * Deliberately NOT gated on {@link canvasMotionEnabled}, unlike the other two. Those exist to keep
 * a CSS transition from starving, and with animations off there is no transition to protect. A drag
 * has no tween either way; the blur costs the same, and the pointer still has to keep up.
 */
export function holdCanvasNodeDrag(): void {
  if (typeof document === "undefined") return;
  const shell = document.querySelector(".codecanvas-shell");
  if (!shell) return;
  shell.setAttribute("data-canvas-dragging", "true");
  window.clearTimeout(dragHoldWatchdog);
  dragHoldWatchdog = window.setTimeout(() => {
    shell.removeAttribute("data-canvas-dragging");
  }, DRAG_HOLD_WATCHDOG_MS);
}

/** End the drag hold. Idempotent — safe on a dragStop for a gesture that never started a hold. */
export function releaseCanvasNodeDrag(): void {
  if (typeof document === "undefined") return;
  window.clearTimeout(dragHoldWatchdog);
  dragHoldWatchdog = undefined;
  document.querySelector(".codecanvas-shell")?.removeAttribute("data-canvas-dragging");
}

let arrangeGlideTimer: number | undefined;

/**
 * Suspend the per-node backdrop blur while a layout glide + camera reframe runs (rule in
 * motion.css keyed on `data-canvas-arranging`) — re-blurring N glass nodes on every animated
 * frame is the most expensive part of the move in WKWebView and starves the tween into a
 * teleport. Shared by arrange AND focus mode so both morphs ride the same CSS transition.
 * Call BEFORE committing final node positions: the forced layout flush keeps WebKit from
 * batching the attribute + transform change into one blink frame. No-op when motion is off.
 */
export function holdCanvasArrangeGlide(durationMs: number): void {
  if (typeof document === "undefined" || !canvasMotionEnabled()) return;
  const shell = document.querySelector(".codecanvas-shell");
  if (!shell) return;
  shell.setAttribute("data-canvas-arranging", "true");
  window.clearTimeout(arrangeGlideTimer);
  arrangeGlideTimer = window.setTimeout(() => shell.removeAttribute("data-canvas-arranging"), durationMs + 160);
  void shell.getBoundingClientRect();
}
