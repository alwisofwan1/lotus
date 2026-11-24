import { useEffect, useLayoutEffect, useRef, useState } from "react";

export const RAIL_ENTER_MS = 280;
export const RAIL_LEAVE_MS = 220;

export type RailPresence = "shown" | "entering" | "leaving";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Whether the rail is mounted, and which way it is moving.
 *
 * The rail PUSHES the work aside, but the work column changes width only once: while the rail
 * moves, it is pulled out of the flow (a negative margin), so the column already has its wide
 * size, and the rail, the seam and the column slide together by transform — on the compositor.
 * Going out, the column widens at the start; coming in, it narrows at the end. Animating the
 * width instead would refit every terminal on every frame: an xterm reflow and a PTY resize per
 * pane, per frame, and a TUI that redraws on each one.
 *
 * The first render is "shown", not "entering": the rail that is there at launch does not slide in.
 */
export function useRailPresence(visible: boolean): RailPresence | null {
  const [state, setState] = useState<RailPresence | null>(visible ? "shown" : null);
  const [seen, setSeen] = useState(visible);

  if (seen !== visible) {
    setSeen(visible);
    const still = prefersReducedMotion();
    setState(visible ? (still ? "shown" : "entering") : still ? null : "leaving");
  }

  useEffect(() => {
    if (state !== "entering" && state !== "leaving") return;
    const timer = window.setTimeout(
      () => setState(state === "entering" ? "shown" : null),
      state === "entering" ? RAIL_ENTER_MS : RAIL_LEAVE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state]);

  return state;
}

/** What the mode's `.ws-body` carries so the stylesheet can move the rail and the work as one. */
export function railMotionProps(presence: RailPresence | null, railSize: number) {
  const moving = presence === "entering" || presence === "leaving";
  return {
    "data-rail-motion": moving ? presence : undefined,
    style: moving ? ({ "--ws-rail-w": `${railSize}px` } as React.CSSProperties) : undefined,
  };
}

const RAIL_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * Plays the push on the rail's slot, the seam and the work column — whatever moves with it.
 *
 * Web Animations with plain pixel values, not a CSS keyframe reading a custom property: the
 * keyframe version ran at 40–60ms frames in WKWebView (measured 2026-10-24), and a transform whose
 * values are known up front is the form WebKit can hand to the compositor.
 */
export function useRailMotion(presence: RailPresence | null, shift: number) {
  const slotRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (presence !== "entering" && presence !== "leaving") return;
    const slot = slotRef.current;
    const body = slot?.parentElement;
    if (!slot || !body) return;
    const movers = [slot, ...body.querySelectorAll<HTMLElement>(":scope > .ws-split, :scope > .ws-column")];
    const from = presence === "entering" ? 0 : shift;
    const to = presence === "entering" ? shift : 0;
    if (typeof slot.animate !== "function") return;
    const animations = movers.map((element) =>
      element.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], {
        duration: presence === "entering" ? RAIL_ENTER_MS : RAIL_LEAVE_MS,
        easing: RAIL_EASE,
        fill: "both",
      }),
    );
    return () => animations.forEach((animation) => animation.cancel());
  }, [presence, shift]);

  return slotRef;
}
