"use client";
import { useEffect, useRef, type RefObject } from "react";

/**
 * Rotates the NL bar's hint phrase directly in the DOM through `slotRef` — no React state, no
 * re-render. The bar already repaints at 60fps during voice capture (spectrum ring, live traces), so
 * a re-render on every ~4.5s tick would be an avoidable cost stacked on top of that. Ports the
 * reference implementation's `makeRotator`/`writeLine`
 * (`plans/nl-command-bar-revamp/preview-full.html`) onto the real two-span slot markup and class
 * names (plan §3.3 "Motion").
 */

const DEFAULT_DWELL_MS = 4500;
/** prefers-reduced-motion doesn't stop the rotator — it slows down (plan §3.3: "stretch the dwell"). */
const REDUCED_MOTION_DWELL_MS = 7000;

const HINT_LINE_CLASS = "canvas-nl-hint-line";
const HINT_WORD_CLASS = "canvas-nl-hint-word";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Writes a phrase into one hint line as per-word spans carrying the `--i` stagger index. Words are
 * joined by CSS flex gap, not space text nodes, so a line's `textContent` is NOT the phrase — callers
 * must track the phrase themselves rather than reading it back out of the DOM (see `currentText`
 * below).
 */
function writeHintLine(line: HTMLElement, phrase: string): void {
  line.replaceChildren(
    ...phrase.split(" ").map((word, i) => {
      const span = document.createElement("span");
      span.className = HINT_WORD_CLASS;
      span.style.setProperty("--i", String(i));
      span.textContent = word;
      return span;
    }),
  );
}

interface HintRotorEngine {
  /** Un-freezes and (re)schedules the next tick, painting the first phrase if nothing has shown yet. */
  start(): void;
  /** Freezes on whatever is currently visible — no DOM change, just stops the timer. */
  stop(): void;
  /** A status message takes the slot over completely; no rotation runs underneath it. */
  set(text: string): void;
  /** Re-paints the phrase the rotation was on before a `set()` — pairs with `start()` to resume. */
  restore(): void;
  dispose(): void;
}

/**
 * One rotor bound to a pair of `.canvas-nl-hint-line` spans. `phrasesRef` is read live on every tick
 * so a phrase list that changes underneath (an agent renamed, a project closed) doesn't require
 * tearing the engine down — only `useNlHintRotator`'s mount effect (slot/dwell identity) does that.
 */
function createHintRotorEngine(
  lines: readonly [HTMLElement, HTMLElement],
  phrasesRef: RefObject<string[]>,
  dwellMs: number,
): HintRotorEngine {
  let index = 0;
  let current: 0 | 1 = 0;
  let timer: number | undefined;
  let frozen = true; // nothing has been scheduled yet until start() runs
  // In word mode a line's DOM text has no spaces between words, so the phrase itself has to be
  // tracked here — reading it back out of the DOM would silently glue the words together.
  let currentText = "";

  function paint(text: string, phase: "hold" = "hold") {
    currentText = text;
    writeHintLine(lines[current], text);
    lines[current].dataset.phase = phase;
    lines[1 - current].dataset.phase = "in";
  }

  function schedule() {
    window.clearTimeout(timer);
    // Reduced motion doesn't stop the rotator, it slows it down — floor the dwell at ~7s rather than
    // hard-overriding a caller-specified value, so an intentionally slower custom dwell still wins.
    const dwell = prefersReducedMotion() ? Math.max(dwellMs, REDUCED_MOTION_DWELL_MS) : dwellMs;
    timer = window.setTimeout(advance, dwell);
  }

  function advance() {
    if (frozen) return;
    const phrases = phrasesRef.current;
    if (phrases.length === 0) {
      schedule();
      return;
    }
    index = (index + 1) % phrases.length;
    const outLine = lines[current];
    const inLine = lines[1 - current];
    currentText = phrases[index];
    writeHintLine(inLine, currentText);
    inLine.dataset.phase = "in";
    void inLine.offsetHeight; // commit the start position before flipping to hold (reference impl)
    outLine.dataset.phase = "out"; // both move in the SAME tick — the slot is never empty mid-swap
    inLine.dataset.phase = "hold";
    current = current === 0 ? 1 : 0;
    schedule();
  }

  return {
    start() {
      frozen = false;
      if (!currentText) {
        const phrases = phrasesRef.current;
        if (phrases.length === 0) return;
        index = 0;
        paint(phrases[index]);
      }
      schedule();
    },
    stop() {
      frozen = true;
      window.clearTimeout(timer);
    },
    set(text: string) {
      frozen = true;
      window.clearTimeout(timer);
      paint(text);
    },
    restore() {
      const phrases = phrasesRef.current;
      const text = phrases[index] ?? phrases[0];
      if (text === undefined) return;
      paint(text);
    },
    dispose() {
      window.clearTimeout(timer);
    },
  };
}

export interface UseNlHintRotatorOptions {
  /** The `.canvas-nl-hint-slot` element — must contain exactly two `.canvas-nl-hint-line` children. */
  slotRef: RefObject<HTMLElement | null>;
  phrases: string[];
  /** Freeze on the current phrase — field non-empty, focused, busy/recording/transcribing, a trace or
   *  confirm/clarify is showing, or a live session is active (plan §3.3 "Yield rules"). */
  suspended: boolean;
  /** Non-null takes the slot over completely (no rotation underneath it) until cleared. */
  pinned: string | null;
  dwellMs?: number;
}

/**
 * `dwellMs` is read once at mount (a stable per-instance config knob, not a runtime-reactive prop —
 * changing it tears down and recreates the rotor, same as changing `slotRef`);
 * `phrases`/`suspended`/`pinned` are read live so an agent joining/leaving or a status message doesn't
 * require remounting the rotor.
 */
export function useNlHintRotator({ slotRef, phrases, suspended, pinned, dwellMs = DEFAULT_DWELL_MS }: UseNlHintRotatorOptions): void {
  const phrasesRef = useRef(phrases);
  // Refs may not be written during render (React reserves that for effects/handlers) — sync it in an
  // effect instead. Declared first so it commits before the effects below ever read phrasesRef for
  // this render.
  useEffect(() => {
    phrasesRef.current = phrases;
  });

  const engineRef = useRef<HintRotorEngine | null>(null);

  // Live values the bind effect needs without taking them as deps (they must not rebuild the engine).
  const stateRef = useRef({ suspended, pinned });
  useEffect(() => {
    stateRef.current = { suspended, pinned };
  });

  /**
   * Apply the yield rules to whichever engine is current. Shared by the bind effect and the effect
   * below so a freshly-bound engine starts in the right state instead of waiting for the next
   * unrelated prop change to kick it.
   *
   * A plain function, not a ref assigned during render: React reserves render for pure output, and
   * this needs no memoisation anyway — it reads `stateRef` at call time, so it can never go stale.
   */
  function applyYieldRules(engine: HintRotorEngine) {
    const { suspended: isSuspended, pinned: isPinned } = stateRef.current;
    const hidden = typeof document !== "undefined" && document.hidden;
    if (isPinned != null) {
      engine.set(isPinned);
    } else if (isSuspended || hidden) {
      engine.restore();
      engine.stop();
    } else {
      engine.restore();
      engine.start();
    }
  }

  // The line element the current engine is bound to, and the dwell it was built with.
  const boundRef = useRef<{ line: HTMLElement | null; dwellMs: number }>({ line: null, dwellMs });

  /**
   * Re-bind whenever the hint's line spans are no longer the ones the engine holds.
   *
   * This effect deliberately has NO dep array, so it runs after every render and compares element
   * identity itself. A `[slotRef]` dep list can never work: a ref's identity never changes, while the
   * DOM behind it does — opening a live-voice session unmounts the whole hint subtree and closing it
   * mounts FRESH line spans. The old effect therefore never re-ran, the engine went on painting into
   * detached nodes, and the bar's placeholder stayed blank until a reload.
   *
   * Element identity is also why this is a ref and not state: setState here would add a render on
   * mount, and "the rotator never causes a re-render" is a load-bearing invariant of this hook (the
   * bar already repaints at 60fps during capture). The comparison is one querySelector over a
   * two-span subtree — cheaper than the render it avoids.
   */
  useEffect(() => {
    const slot = slotRef.current;
    const first = slot?.querySelector<HTMLElement>(`.${HINT_LINE_CLASS}`) ?? null;
    if (first === boundRef.current.line && dwellMs === boundRef.current.dwellMs) return;

    engineRef.current?.dispose();
    engineRef.current = null;
    boundRef.current = { line: first, dwellMs };
    if (!slot) return;
    const lines = Array.from(slot.querySelectorAll<HTMLElement>(`.${HINT_LINE_CLASS}`));
    if (lines.length !== 2) return; // structural contract from the plan — bail rather than guess at markup
    const engine = createHintRotorEngine([lines[0], lines[1]], phrasesRef, dwellMs);
    engineRef.current = engine;
    applyYieldRules(engine); // paint immediately; don't wait for an unrelated prop to change
  });

  // Unmount only: no timer may outlive the component (and an HMR remount in dev must not double up).
  useEffect(
    () => () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      boundRef.current = { line: null, dwellMs: 0 };
    },
    [],
  );

  // A content key, not the array reference: `phrases` is commonly a freshly-built array on every
  // render (buildNlHintPhrases returns a new array), and keying the effect below on that reference
  // would restart the cycle on every unrelated re-render. Keying on content still re-runs the effect
  // the moment phrases actually change — including the empty→populated transition on first mount,
  // which a bare `phrases` exclusion would miss entirely (nothing would ever kick the first paint off
  // if the board's phrase list wasn't ready on the very first render).
  const phrasesKey = phrases.join("|");

  // Yield rules (plan §3.3): pinned wins outright over rotation; suspended freezes on the current
  // phrase; otherwise keep rotating. document.hidden is handled by the visibility effect below so
  // this one doesn't have to re-run on every visibility flip.
  // Note applyYieldRules' `suspended` branch does restore() before stop(), not stop() alone: a status can
  // clear WHILE suspended (a trace auto-dismisses after 4.5s while the user sits focused in the empty
  // field). Freezing without repainting would leave that stale status text sitting in the slot as the
  // prompt until the next blur — the old bar returned to its resting placeholder here, so must this.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    applyYieldRules(engine);
  }, [pinned, suspended, phrasesKey]);

  // No work in a background window, and resume the moment it's foregrounded again (unless still
  // suspended or pinned) — the tab regaining focus is the one transition the effect above can't see.
  useEffect(() => {
    const onVisibility = () => {
      const engine = engineRef.current;
      if (!engine) return;
      if (document.hidden) {
        engine.stop();
      } else if (!suspended && pinned == null) {
        engine.restore();
        engine.start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [suspended, pinned]);
}
