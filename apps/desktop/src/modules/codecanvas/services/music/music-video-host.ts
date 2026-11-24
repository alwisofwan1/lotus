/**
 * The session's one and only video surface (plan
 * `plans/canvas-music-persistent-playback/PLAN.md` Tahap 2).
 *
 * An `<iframe>` cannot be re-parented without reloading, so the player element is
 * created ONCE, appended to `document.body`, and never moved again. Surfaces that
 * want to show the video register a **slot** — a plain, empty box in their own
 * layout — and this module positions the host over the winning slot's rect.
 * Nothing is ever mounted or unmounted to make the video "move": only a transform
 * changes, so the audio is never interrupted.
 *
 * Slot priority: a canvas MusicNode outranks the app-level mini player. When the
 * node's slot goes away or stops being visible (project switch, route change, LOD
 * collapse, scrolled out of the canvas), the mini player's slot takes over.
 *
 * Geometry is event-driven with an idle-out: the follow loop runs while the rect
 * keeps changing (pan, zoom, drag) and parks itself ~1.5s after things settle,
 * leaving a 500ms safety pass. Hidden means translated off-screen, never
 * `display: none` — WebKit is entitled to suspend a display:none frame, and
 * suspending is exactly what we are here to prevent.
 */
import { useSyncExternalStore } from "react";

export const VIDEO_HOST_ID = "lotus-music-video-host";

export type VideoSlotKind = "node" | "dock";

/** Node wins: when a music node is on screen the video belongs in it. */
const SLOT_PRIORITY: Record<VideoSlotKind, number> = { node: 2, dock: 1 };
/**
 * Stacking: over the canvas (its viewport is transformed, so node z-indexes stay
 * trapped inside it) but under every piece of floating chrome — tool rail (6),
 * corner controls (32), panels (100), toasts (120), modals (140+). The dock slot
 * needs to clear the dock's own surface (110) instead.
 */
const SLOT_Z_INDEX: Record<VideoSlotKind, number> = { node: 2, dock: 111 };
/** Below this visible area a slot is not worth showing video in — also kills flapping. */
const MIN_VISIBLE_PX = 24;
/** Frames without a geometry change before the follow loop parks itself. */
const IDLE_FRAMES = 90;
/** Safety pass while parked, for rect changes no event announced. */
const SAFETY_PASS_MS = 500;

export interface VideoSlotOptions {
  kind: VideoSlotKind;
  /** Ancestor box the slot is clipped by (e.g. the ReactFlow pane). */
  clipTo?: HTMLElement | null;
  /** Corner rounding copied onto the host so it matches the slot's frame. */
  borderRadius?: string;
}

interface VideoSlot extends VideoSlotOptions {
  element: HTMLElement;
  token: number;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

let host: HTMLDivElement | null = null;
let player: HTMLIFrameElement | null = null;
let active = false;
let slots: VideoSlot[] = [];
let slotToken = 0;
let owner: VideoSlotKind | null = null;
const ownerListeners = new Set<() => void>();
let rafHandle: number | null = null;
let safetyTimer: ReturnType<typeof setInterval> | null = null;
let unchangedFrames = 0;
let appliedStyle = "";
let wakeBound = false;

const WAKE_EVENTS = [
  "pointerdown",
  "pointerup",
  "wheel",
  "keydown",
  "resize",
  "transitionend",
  "animationend",
] as const;

function emitOwner() {
  ownerListeners.forEach((listener) => listener());
}

function setOwner(next: VideoSlotKind | null) {
  if (owner === next) return;
  owner = next;
  emitOwner();
}

/** Create the host + player element exactly once. Idempotent, and HMR-safe by id. */
export function ensureVideoHost(): HTMLIFrameElement {
  if (player && host?.isConnected) return player;

  const existing = document.getElementById(VIDEO_HOST_ID);
  if (existing instanceof HTMLDivElement) {
    host = existing;
    const found = existing.querySelector("iframe");
    if (found instanceof HTMLIFrameElement) {
      player = found;
      bindWakeEvents();
      return found;
    }
  }

  if (!host) {
    host = document.createElement("div");
    host.id = VIDEO_HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.position = "fixed";
    host.style.left = "0";
    host.style.top = "0";
    host.style.overflow = "hidden";
    host.style.background = "#000";
    host.style.contain = "strict";
  }
  hideHost();
  if (!host.isConnected) document.body.appendChild(host);

  player = document.createElement("iframe");
  player.title = "Music player";
  player.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
  player.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  player.style.display = "block";
  player.style.width = "100%";
  player.style.height = "100%";
  player.style.border = "0";
  host.appendChild(player);

  bindWakeEvents();
  scheduleLayout();
  return player;
}

/** The player element, when one has been created. */
export function getVideoPlayerElement(): HTMLIFrameElement | null {
  return player;
}

/**
 * Whether there is live audio to show. Inactive parks the host off-screen and
 * reports no owner, so the mini player can hide too.
 */
export function setVideoHostActive(next: boolean): void {
  if (active === next) return;
  active = next;
  if (!active) {
    hideHost();
    setOwner(null);
    stopLoop();
    return;
  }
  wake();
}

export function isVideoHostActive(): boolean {
  return active;
}

/**
 * Offer a box for the video. Returns the release callback — call it on unmount.
 * Re-registering the same element just refreshes its options.
 */
export function registerVideoSlot(element: HTMLElement, options: VideoSlotOptions): () => void {
  const token = ++slotToken;
  slots = [...slots.filter((slot) => slot.element !== element), { ...options, element, token }];
  wake();
  return () => {
    slots = slots.filter((slot) => slot.token !== token);
    wake();
  };
}

export function getVideoSlotOwner(): VideoSlotKind | null {
  return owner;
}

export function subscribeVideoSlotOwner(listener: () => void): () => void {
  ownerListeners.add(listener);
  return () => {
    ownerListeners.delete(listener);
  };
}

const getServerOwner = (): VideoSlotKind | null => null;

/** React binding — which surface currently holds the video. */
export function useVideoSlotOwner(): VideoSlotKind | null {
  return useSyncExternalStore(subscribeVideoSlotOwner, getVideoSlotOwner, getServerOwner);
}

function viewportBox(): Box {
  return {
    left: 0,
    top: 0,
    right: typeof window === "undefined" ? 0 : window.innerWidth,
    bottom: typeof window === "undefined" ? 0 : window.innerHeight,
  };
}

function intersect(a: Box, b: Box): Box {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

interface Placement {
  slot: VideoSlot;
  style: string;
}

/** Highest-priority slot that is actually on screen, with the style it implies. */
function resolvePlacement(): Placement | null {
  // Priority first; among equals the newest registration wins, so with two music
  // nodes open the video sits in the one you opened last.
  const candidates = [...slots].sort(
    (a, b) => SLOT_PRIORITY[b.kind] - SLOT_PRIORITY[a.kind] || b.token - a.token,
  );
  for (const slot of candidates) {
    if (!slot.element.isConnected) continue;
    const rect = slot.element.getBoundingClientRect();
    if (rect.width < MIN_VISIBLE_PX || rect.height < MIN_VISIBLE_PX) continue;

    const box: Box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    let clip = intersect(box, viewportBox());
    if (slot.clipTo?.isConnected) {
      const clipRect = slot.clipTo.getBoundingClientRect();
      clip = intersect(clip, {
        left: clipRect.left,
        top: clipRect.top,
        right: clipRect.right,
        bottom: clipRect.bottom,
      });
    }
    const visibleWidth = clip.right - clip.left;
    const visibleHeight = clip.bottom - clip.top;
    if (visibleWidth < MIN_VISIBLE_PX || visibleHeight < MIN_VISIBLE_PX) continue;

    // Clip in the host's own coordinates so a node half-out of the canvas pane does
    // not bleed the video over the app chrome around it.
    const inset = [
      clip.top - box.top,
      box.right - clip.right,
      box.bottom - clip.bottom,
      clip.left - box.left,
    ].map((value) => `${Math.max(0, Math.round(value))}px`);
    const radius = slot.borderRadius && slot.borderRadius !== "0px" ? ` round ${slot.borderRadius}` : "";

    return {
      slot,
      style: [
        `transform: translate3d(${Math.round(box.left)}px, ${Math.round(box.top)}px, 0)`,
        `width: ${Math.round(rect.width)}px`,
        `height: ${Math.round(rect.height)}px`,
        `z-index: ${SLOT_Z_INDEX[slot.kind]}`,
        `border-radius: ${slot.borderRadius ?? "0px"}`,
        `clip-path: inset(${inset.join(" ")}${radius})`,
        "opacity: 1",
        "pointer-events: auto",
      ].join("; "),
    };
  }
  return null;
}

function hideHost() {
  if (!host) return;
  // Off-screen, not display:none — a suspended frame is the bug we are avoiding.
  const style = "transform: translate3d(-10000px, 0, 0); width: 320px; height: 180px; z-index: 2; opacity: 0; pointer-events: none";
  if (appliedStyle === style) return;
  appliedStyle = style;
  host.setAttribute("style", `${baseHostStyle()}; ${style}`);
}

function baseHostStyle(): string {
  return "position: fixed; left: 0; top: 0; overflow: hidden; background: #000; contain: strict";
}

/** One positioning pass. Returns true when anything actually moved. */
function layoutPass(): boolean {
  if (!host) return false;
  if (!active) {
    const before = appliedStyle;
    hideHost();
    setOwner(null);
    return before !== appliedStyle;
  }
  const placement = resolvePlacement();
  if (!placement) {
    const before = appliedStyle;
    hideHost();
    setOwner(null);
    return before !== appliedStyle;
  }
  setOwner(placement.slot.kind);
  if (appliedStyle === placement.style) return false;
  appliedStyle = placement.style;
  host.setAttribute("style", `${baseHostStyle()}; ${placement.style}`);
  return true;
}

function tick() {
  rafHandle = null;
  const changed = layoutPass();
  unchangedFrames = changed ? 0 : unchangedFrames + 1;
  if (unchangedFrames >= IDLE_FRAMES) {
    stopLoop();
    return;
  }
  scheduleLayout();
}

function scheduleLayout() {
  if (typeof window === "undefined" || rafHandle !== null) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  rafHandle = window.requestAnimationFrame(tick);
}

function stopLoop() {
  if (rafHandle !== null && typeof window !== "undefined") window.cancelAnimationFrame(rafHandle);
  rafHandle = null;
}

/** Something may have moved — resume following. */
function wake() {
  // Inactive means already parked off-screen; following rects would be pure layout cost.
  if (!active) return;
  unchangedFrames = 0;
  scheduleLayout();
}

/**
 * Only a scroll that can move a slot matters. Auto-scrolling terminals fire `scroll`
 * nonstop, and treating each one as a wake kept a getBoundingClientRect loop running.
 */
function wakeOnScroll(event: Event) {
  const target = event.target;
  if (target instanceof Node && slots.some((slot) => target.contains(slot.element))) wake();
}

function bindWakeEvents() {
  if (wakeBound || typeof window === "undefined") return;
  wakeBound = true;
  for (const event of WAKE_EVENTS) {
    window.addEventListener(event, wake, { capture: true, passive: true });
  }
  window.addEventListener("scroll", wakeOnScroll, { capture: true, passive: true });
  document.addEventListener("visibilitychange", wake);
  // Cheap backstop for rect changes nothing announces (layout settling, fonts).
  safetyTimer = setInterval(() => {
    if (active && rafHandle === null) layoutPass();
  }, SAFETY_PASS_MS);
}

/**
 * Nudge the follow loop after a change no wake event announces — e.g. the mini
 * player expanding, which makes a new slot appear a frame later.
 */
export function wakeVideoHost(): void {
  wake();
}

/** Test seam: run the follow loop's work synchronously. */
export function flushVideoHostLayoutForTests(): boolean {
  return layoutPass();
}

/** Test-only: drop the host, the player, and every registered slot. */
export function resetVideoHostForTests(): void {
  stopLoop();
  if (safetyTimer) {
    clearInterval(safetyTimer);
    safetyTimer = null;
  }
  if (wakeBound && typeof window !== "undefined") {
    for (const event of WAKE_EVENTS) {
      window.removeEventListener(event, wake, { capture: true });
    }
    window.removeEventListener("scroll", wakeOnScroll, { capture: true });
    document.removeEventListener("visibilitychange", wake);
  }
  wakeBound = false;
  host?.remove();
  document.getElementById(VIDEO_HOST_ID)?.remove();
  host = null;
  player = null;
  active = false;
  slots = [];
  slotToken = 0;
  owner = null;
  ownerListeners.clear();
  unchangedFrames = 0;
  appliedStyle = "";
}
