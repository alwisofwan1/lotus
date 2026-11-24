/*
 * Runs a theme switch as an animated View Transition (Theme 08/15). The browser snapshots the old
 * page, `update` applies the new theme, and the two are animated: a crossfade by default, or — given
 * the point the user pressed — the new theme growing as a circle from it. Where the user asks for
 * reduced motion, or the platform has no View Transitions, `update` runs immediately instead — never
 * a half-applied theme, only an unanimated one.
 *
 * Both live in styles/design-system.css; `data-theme-reveal` on <html> picks the circle there.
 *
 * `data-theme-switching` on <html> suppresses every CSS transition while the theme applies: ~130
 * elements transition their colours, and letting them all animate at once only costs frames under a
 * switch that is already animated as a whole.
 *
 * `update` must apply the whole theme before it returns: a change applied later misses the new
 * snapshot and shows as a second, unanimated jump. It must also stay cheap — the reveal cannot start
 * until the new page has been rendered for its snapshot, so whatever `update` sets off is the delay
 * between the press and the circle.
 *
 * A skipped transition (window hidden, or a second switch before the first finished) rejects `ready`
 * and `finished`; the theme is applied all the same, so those rejections are expected and dropped.
 * `updateCallbackDone` is left alone: it rejects only when `update` itself throws.
 */
type ViewTransitionLike = { ready?: Promise<unknown>; finished?: Promise<unknown> };
type StartViewTransition = (update: () => void) => ViewTransitionLike | undefined;

/** A point in viewport pixels, where the reveal circle starts. */
export type ThemeRevealOrigin = { x: number; y: number };

const REVEAL_ATTRIBUTE = "data-theme-reveal";
const SWITCHING_ATTRIBUTE = "data-theme-switching";

/**
 * Where a press on `element` should start the reveal: the pointer for a click, the element's centre
 * for a keyboard press (a keyboard click reports 0,0, which would start the circle in a corner).
 */
export function themeRevealOrigin(
  element: Element | null | undefined,
  pointer?: { clientX: number; clientY: number; detail?: number },
): ThemeRevealOrigin | undefined {
  if (pointer && pointer.detail !== 0) return { x: pointer.clientX, y: pointer.clientY };
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// Only the latest switch may clear the flags: a superseded one finishes while the next runs.
let switchGeneration = 0;

// Settles when the transition on screen has finished animating (at once when none is running).
let settled: Promise<void> = Promise.resolve();

/**
 * Waits for the running theme transition to finish. Work that makes WebKit repaint everything — the
 * native window appearance — waits here, so it neither delays the snapshot nor stutters the animation.
 */
export function whenThemeTransitionSettles(): Promise<void> {
  return settled;
}

/** Applies `update` with CSS transitions suppressed, and lifts the suppression once styles have resolved. */
function applySwitch(root: HTMLElement, generation: number, update: () => void): void {
  root.setAttribute(SWITCHING_ATTRIBUTE, "");
  try {
    update();
  } finally {
    // Resolve the new styles while transitions are still off, or lifting the flag in the same style
    // pass would start every one of them anyway.
    void root.offsetHeight;
    if (generation === switchGeneration) root.removeAttribute(SWITCHING_ATTRIBUTE);
  }
}

export function runThemeTransition(update: () => void, origin?: ThemeRevealOrigin): void {
  if (typeof document === "undefined") {
    update();
    return;
  }
  const root = document.documentElement;
  const generation = ++switchGeneration;
  const start = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof start !== "function" || reducedMotion) {
    applySwitch(root, generation, update);
    return;
  }

  if (origin) {
    // Far enough to reach the corner farthest from the origin, so the circle ends covering the window.
    const radius = Math.hypot(
      Math.max(origin.x, window.innerWidth - origin.x),
      Math.max(origin.y, window.innerHeight - origin.y),
    );
    root.style.setProperty("--ds-reveal-x", `${origin.x}px`);
    root.style.setProperty("--ds-reveal-y", `${origin.y}px`);
    root.style.setProperty("--ds-reveal-r", `${Math.ceil(radius)}px`);
    root.setAttribute(REVEAL_ATTRIBUTE, "");
  } else {
    root.removeAttribute(REVEAL_ATTRIBUTE);
  }

  const transition = start.call(document, () => applySwitch(root, generation, update));
  transition?.ready?.catch(() => undefined);
  settled = (transition?.finished ?? Promise.resolve()).then(
    () => undefined,
    () => undefined,
  );
  void settled.then(() => {
    if (generation === switchGeneration) root.removeAttribute(REVEAL_ATTRIBUTE);
  });
}
