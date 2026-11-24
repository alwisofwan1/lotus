"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TOAST_POSITION,
  TOAST_MAX_OPEN_CARDS,
  toastStackHeightRem,
  type CompletionToast,
  type ToastPosition,
  type ToastStackView,
} from "../services/agent-completion-toast";

/**
 * App-level "agent finished" toasts — a small, calm, lamplit card pinned to the canvas bottom-right.
 * Names the PROJECT the agent finished in so multi-project work stays legible, works whether or not
 * voice is on, and never steals keyboard focus (a polite live region, no autofocus).
 *
 * Colored purely through the active Artisan theme (`--cc-toast-*` in theme.css, all derived from
 * `--canvas-*`), so the card re-skins — and inverts for a light theme — instead of carrying its own
 * palette. The completion signal is pushed in via `useAgentCompletionToasts`.
 *
 * Three affordances carry the interaction: the whole card is the primary action (lifts on hover), a
 * hairline life bar shows the time left before auto-dismiss, and the ✕ dismisses just this one.
 */

export interface AgentCompletionToastsProps {
  view: ToastStackView;
  /** Where the stack anchors on the canvas (Settings → Canvas). Defaults to bottom-right. */
  position?: ToastPosition;
  /** Whether completion cards expire after their adaptive duration. Defaults to true. */
  autoDismiss?: boolean;
  /** Remove one toast (close button / auto-expire). */
  onDismiss: (id: string) => void;
  /** Primary action: focus the agent (same project) or switch to its project (background). */
  onActivate: (toast: CompletionToast) => void;
}

/** Scalloped verified-style seal, generated once: r(θ) = base·(1 + amp·cos(lobes·θ)). Pure math, so
 *  it is crisp at any size and tints with the theme instead of shipping a raster asset. */
const SEAL_PATH = (() => {
  const lobes = 11, amp = 0.085, steps = 132, cx = 12, cy = 12, base = 10.4;
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const r = base * (1 + amp * Math.cos(lobes * t));
    const x = cx + Math.cos(t - Math.PI / 2) * r;
    const y = cy + Math.sin(t - Math.PI / 2) * r;
    d += `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return `${d}Z`;
})();

/** The seal sits in its own pool of light (the ::after ambient disc in CSS). It takes no scope prop:
 *  the card owns `--cc-toast-signal`, and the seal — like the rail, life bar, and project ink —
 *  simply inherits it, so one variable re-tints the whole card. */
function Seal() {
  return (
    <span className="canvas-agent-toast__seal" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path className="canvas-agent-toast__seal-body" d={SEAL_PATH} />
        <path className="canvas-agent-toast__seal-check" d="M8.3 12.2l2.5 2.5 4.9-5.2" />
      </svg>
    </span>
  );
}

/** Auto-dismiss with hover/focus pause. The countdown is silent (no progress bar) and only runs
 *  while the window is focused — an away-from-app finish waits until the user is back to see it.
 *  Pauses bank the REMAINING time: an inspected toast picks its countdown back up where it left
 *  off instead of being granted a fresh full life on every hover. */
function useAutoDismiss(id: string, durationMs: number, enabled: boolean, onDismiss: (id: string) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(durationMs);
  const startedAtRef = useRef<number | null>(null);
  const previousEnabledRef = useRef(enabled);

  // A new finish (id) or duration means a fresh time budget — including the latest-wins morph,
  // where the same card (keyed by dedupeKey) starts representing a NEW completion event.
  useEffect(() => {
    remainingRef.current = durationMs;
    startedAtRef.current = null;
  }, [id, durationMs]);

  // Turning auto-dismiss back on is an explicit new policy choice. Give every visible card a full
  // readable budget instead of letting an old nearly-spent timer make it disappear immediately.
  useEffect(() => {
    if (enabled && !previousEnabledRef.current) {
      remainingRef.current = durationMs;
      startedAtRef.current = null;
    }
    previousEnabledRef.current = enabled;
  }, [enabled, durationMs]);

  const pause = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (startedAtRef.current !== null) {
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
      startedAtRef.current = null;
    }
  }, []);
  const resume = useCallback(() => {
    pause();
    if (!enabled || (typeof document !== "undefined" && document.hidden)) return;
    startedAtRef.current = Date.now();
    timer.current = setTimeout(() => {
      startedAtRef.current = null;
      onDismiss(id);
    }, remainingRef.current);
  }, [pause, enabled, id, onDismiss]);

  useEffect(() => {
    resume();
    if (typeof document === "undefined") return pause;
    // Pause a running countdown when the app goes to the background and resume it on return, so an
    // away-from-app finish is still on screen when the user comes back (not silently timed out).
    const onVisibility = () => {
      if (document.hidden) pause();
      else resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      pause();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [resume, pause]);

  return { pause, resume };
}

/** Upper bound for the exit animation before removal is forced — covers environments where CSS
 *  animation events never arrive (reduced motion's short fade still fires; `animation: none`,
 *  jsdom, or a display:none ancestor would not). Slightly above the longest exit keyframe. */
const TOAST_EXIT_FALLBACK_MS = 400;

function ToastCard({ toast, stackIndex, suspended, autoDismiss, onDismiss, onActivate }: {
  toast: CompletionToast;
  /** Distance from the newest card: 0 = front of the deck; CSS derives depth/offset from it. */
  stackIndex: number;
  /** True while the deck is open (hover/focus/expanded) — every card's countdown pauses together,
   *  so nothing slips away mid-inspection. */
  suspended: boolean;
  autoDismiss: boolean;
  onDismiss: (id: string) => void;
  onActivate: (toast: CompletionToast) => void;
}) {
  // Leaving = the exit animation is playing; the toast is only REMOVED (onDismiss) when it ends.
  // Every dismissal path (close button, activation, auto-expire) funnels through beginLeave so
  // nothing pops out.
  const [leaving, setLeaving] = useState(false);
  const beginLeave = useCallback(() => setLeaving(true), []);
  // Latest-wins morph: the card is keyed by dedupeKey, so a re-firing agent REUSES this component
  // with a new toast id. Un-leave during render so a card mid-exit snaps back to represent the
  // fresh finish (its stale dismissal timer is cleaned up by the leaving effect below).
  const [prevToastId, setPrevToastId] = useState(toast.id);
  if (prevToastId !== toast.id) {
    setPrevToastId(toast.id);
    if (leaving) setLeaving(false);
  }
  const { pause, resume } = useAutoDismiss(toast.id, toast.durationMs, autoDismiss, beginLeave);

  // Deck-level suspension replaces per-card hover pausing: hovering ANY card opens the deck, and an
  // open deck holds every countdown.
  useEffect(() => {
    if (leaving) return;
    if (suspended) pause();
    else resume();
  }, [suspended, leaving, pause, resume]);

  useEffect(() => {
    if (!leaving) return;
    pause(); // countdown is done with — only the exit animation owns the card now
    const t = setTimeout(() => onDismiss(toast.id), TOAST_EXIT_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [leaving, pause, onDismiss, toast.id]);

  return (
    <li
      className={`canvas-agent-toast canvas-agent-toast--${toast.scope}`}
      style={
        {
          "--stack-i": String(stackIndex),
          // Feeds the life bar's CSS animation, so the visible drain always matches this toast's
          // OWN budget (6s same-project / 10s background) with no JS ticking a progress value.
          "--toast-life": `${toast.durationMs}ms`,
        } as React.CSSProperties
      }
      data-leaving={leaving ? "true" : undefined}
      onAnimationEnd={(e) => {
        // Matches every exit keyframe (-right / -left / -sink / -fade) but never the entry animation.
        if (leaving && e.animationName.startsWith("canvas-agent-toast-out")) onDismiss(toast.id);
      }}
    >
      <button
        type="button"
        className="canvas-agent-toast__hit"
        onClick={() => {
          onActivate(toast);
          beginLeave(); // the toast served its purpose — glide out like every other dismissal
        }}
        /* The card is the primary action, so its label spells out what a click DOES — including the
           project hop for a background finish, which the ↗ alone only hints at visually. */
        aria-label={
          toast.projectLabel
            ? toast.scope === "background"
              ? `Open ${toast.agentName} — finished in ${toast.projectLabel} (switches project)`
              : `Open ${toast.agentName} — finished in ${toast.projectLabel}`
            : `Open ${toast.agentName}`
        }
      >
        <Seal />
        <span className="canvas-agent-toast__body">
          <span className="canvas-agent-toast__title">{toast.agentName}</span>
          <span className="canvas-agent-toast__sub">
            {toast.projectLabel ? (
              /* Project label alone — the seal already says "done"; a prefix only stole ellipsis room. */
              <>
                <span className="canvas-agent-toast__proj">{toast.projectLabel}</span>
                {toast.scope === "background" ? <span className="canvas-agent-toast__ext" aria-hidden="true">↗</span> : null}
              </>
            ) : (
              "Done"
            )}
          </span>
        </span>
      </button>
      {/* Visible countdown. Keyed by toast.id so a latest-wins morph restarts the drain from full
          instead of inheriting the previous finish's spent animation. */}
      {autoDismiss ? <span key={toast.id} className="canvas-agent-toast__life" aria-hidden="true" /> : null}
      <button type="button" className="canvas-agent-toast__close" aria-label={`Dismiss ${toast.agentName} notification`} onClick={beginLeave}>
        {/* hairline ×, drawn (not typed) so it stays optically centered and weight-matched */}
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.2 2.2l5.6 5.6M7.8 2.2L2.2 7.8" />
        </svg>
      </button>
    </li>
  );
}

export function AgentCompletionToasts({
  view,
  position = DEFAULT_TOAST_POSITION,
  autoDismiss = true,
  onDismiss,
  onActivate,
}: AgentCompletionToastsProps) {
  const { visible, collapsed, collapsedCount } = view;
  // "View all" (the +N chip) reveals the folded toasts as cards IN PLACE — nothing is discarded.
  const [expanded, setExpanded] = useState(false);
  // Hover or keyboard focus fans the collapsed deck open; leaving lets it settle back.
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  // Reset the sticky expansion once the stack drains, so the next batch starts as a calm deck.
  // Render-phase adjustment (not an effect): React re-renders immediately with the reset state.
  const [prevCollapsedCount, setPrevCollapsedCount] = useState(collapsedCount);
  if (prevCollapsedCount !== collapsedCount) {
    setPrevCollapsedCount(collapsedCount);
    if (collapsedCount === 0 && expanded) setExpanded(false);
  }

  // The open column is HARD-CAPPED: the newest TOAST_MAX_OPEN_CARDS become cards, anything older
  // stays folded and the chip keeps its tally (as cards expire, the folded ones surface).
  const revealBudget = Math.max(0, TOAST_MAX_OPEN_CARDS - visible.length);
  const revealed = expanded ? collapsed.slice(-revealBudget) : [];
  const cards = [...revealed, ...visible];
  const foldedCount = expanded ? collapsed.length - revealed.length : collapsedCount;

  // Dismissing the last card WHILE hovering unmounts the list before any mouseleave can fire, so
  // the hover/focus flags would stay latched and the next toast would be born "open" with its
  // countdown suspended forever. Clear them the moment the deck is empty (render-phase, guarded).
  if (cards.length === 0 && (hoverOpen || focusOpen)) {
    setHoverOpen(false);
    setFocusOpen(false);
  }

  const open = cards.length > 0 && (hoverOpen || focusOpen || expanded);

  return (
    <div className="canvas-agent-toast-host" data-pos={position} role="status" aria-live="polite" aria-atomic="false">
      {foldedCount > 0 ? (
        /* Two different things wear the same chip. Unexpanded it is a real button that reveals the
           folded finishes. Already expanded (the column hit its cap) it is a pure TALLY — rendered
           as a span, not a disabled button, so the user never clicks a dead control and wonders
           why nothing happened. */
        expanded ? (
          <span
            className="canvas-agent-toast-chip"
            data-inert="true"
            title={`${foldedCount} older ${foldedCount === 1 ? "finish" : "finishes"} stay folded until the column drains`}
          >
            +{foldedCount}
          </span>
        ) : (
          <button
            type="button"
            className="canvas-agent-toast-chip"
            onClick={() => setExpanded(true)}
            aria-label={`View all finished agents (${foldedCount} more)`}
          >
            +{foldedCount}
          </button>
        )
      ) : null}
      {cards.length > 0 ? (
        /* The list is the deck: a fixed-size box (height below) that owns hover/focus. Collapsed it
           is exactly the front card + peeks; open it spans the whole column, so the pointer can
           travel between cards without the deck snapping shut. */
        <ol
          className="canvas-agent-toast-list"
          data-open={open ? "true" : undefined}
          style={{ height: toastStackHeightRem(cards.length, open) }}
          onMouseEnter={() => setHoverOpen(true)}
          onMouseLeave={() => setHoverOpen(false)}
          onFocusCapture={() => setFocusOpen(true)}
          onBlurCapture={() => setFocusOpen(false)}
        >
          {cards.map((toast, idx) => (
            <ToastCard
              /* dedupeKey (unique per agent in the list): a re-firing agent morphs its card in
                 place instead of popping the old card out and sliding a clone back in */
              key={toast.dedupeKey}
              toast={toast}
              stackIndex={cards.length - 1 - idx}
              suspended={open}
              autoDismiss={autoDismiss}
              onDismiss={onDismiss}
              onActivate={onActivate}
            />
          ))}
        </ol>
      ) : null}
    </div>
  );
}
