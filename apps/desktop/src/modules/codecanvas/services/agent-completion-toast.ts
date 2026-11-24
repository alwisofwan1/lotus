/**
 * Agent completion toast — pure model + stack policy.
 *
 * A finished agent shows a small app-level toast (bottom-right) that names the PROJECT it finished
 * in, so a user juggling several projects always knows WHERE the work landed. This module owns only
 * the data: how a raw finish becomes a toast, how a re-firing agent de-dupes, and how the stack
 * collapses. Rendering, timers, and the completion signal are wired separately (see
 * `AgentCompletionToasts` / `useAgentCompletionToasts` / `useAgentDoneCallouts`).
 *
 * The same/background classification MIRRORS the voice callout policy (see `resolveFinishCallout`)
 * so the two channels never disagree about which project an agent belongs to.
 */

export type CompletionToastScope = "same" | "background";

/**
 * Where the completion-toast stack anchors inside the canvas. User-configurable (Settings → Canvas)
 * and persisted; the component maps it to a `data-pos` attribute that CSS turns into the corner/edge
 * anchor. `bottom-right` is the historical default.
 */
export type ToastPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left" | "bottom-center";
export const DEFAULT_TOAST_POSITION: ToastPosition = "bottom-right";
export const TOAST_POSITIONS: ToastPosition[] = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
  "bottom-center",
];

/** Coerce an unknown/legacy persisted value back to a supported position (forward-compatible
 *  settings): anything not in {@link TOAST_POSITIONS} becomes {@link DEFAULT_TOAST_POSITION}. */
export function normalizeToastPosition(value: unknown): ToastPosition {
  return TOAST_POSITIONS.includes(value as ToastPosition) ? (value as ToastPosition) : DEFAULT_TOAST_POSITION;
}

/** How long a toast lingers before auto-dismiss — a background finish stays longer because it is
 *  less likely to already be on screen. */
export const SAME_PROJECT_DURATION_MS = 6_000;
export const BACKGROUND_PROJECT_DURATION_MS = 10_000;

/** Newest toasts shown as full cards; the rest fold behind a "+N" chip. */
export const DEFAULT_MAX_VISIBLE_TOASTS = 3;

/* ── stacked-deck geometry ──
   Cards have a FIXED height (title + one ellipsized sub line), which is what lets the deck be pure
   CSS: collapsed back-cards peek out by a constant sliver, and the open column offsets each card by
   exactly one card-height + gap — no measuring, no layout thrash. All in rem so it scales with the
   root font size. */
export const TOAST_CARD_H_REM = 2.5;
export const TOAST_STACK_GAP_REM = 0.5;
export const TOAST_STACK_PEEK_REM = 0.5625;
/** Back layers that stay visible behind the front card; deeper cards hide until the deck opens. */
export const TOAST_STACK_MAX_LAYERS = 3;
/** Hard cap on cards in the OPEN column — 6 × (card + gap) ≈ 21rem stays inside any realistic
 *  canvas height. Anything older stays folded behind the chip's tally until the column drains. */
export const TOAST_MAX_OPEN_CARDS = 6;

/** The stack's reserved box height (the hover/expand hit area and layout size), as a rem length.
 *  Collapsed: the front card plus one peek sliver per visible back layer. Open: the full column. */
export function toastStackHeightRem(count: number, open: boolean): string {
  if (count <= 0) return "0rem";
  if (open) return `${count * TOAST_CARD_H_REM + (count - 1) * TOAST_STACK_GAP_REM}rem`;
  return `${TOAST_CARD_H_REM + (Math.min(count, TOAST_STACK_MAX_LAYERS) - 1) * TOAST_STACK_PEEK_REM}rem`;
}

export interface CompletionToast {
  /** Unique per finish event (React key + dismiss target). */
  id: string;
  /** Agent identity — a re-firing agent replaces its own toast instead of stacking (latest-wins). */
  dedupeKey: string;
  /** ReactFlow node id of the finished agent (used to focus it on click). */
  agentId: string;
  /** Display name shown as the toast title. */
  agentName: string;
  /** The agent's own project id — drives the click action for a background finish. */
  agentProjectId?: string;
  /** Human repo label for the "Done on ⟨project⟩" line; null when unknown. */
  projectLabel: string | null;
  scope: CompletionToastScope;
  durationMs: number;
  /** Injected clock stamp (ms) — kept in the model so ordering never depends on array insertion. */
  createdAt: number;
}

export interface BuildCompletionToastInput {
  /** Unique id for this finish event. */
  eventId: string;
  agentId?: string;
  agentName?: string | null;
  /** The finished agent's own project id (resolved from the roster / identity / scoped paneId). */
  agentProjectId?: string | null;
  /** The project currently on screen. */
  activeProjectId?: string | null;
  /** projectId → human repo label; consulted for the "Done on ⟨project⟩" line. */
  resolveProjectLabel?: (projectId: string) => string | null | undefined;
  /** Injected clock (ms). */
  now: number;
}

/**
 * Same vs background, mirroring the voice policy: a finish is BACKGROUND only when the agent has a
 * known project that differs from the one on screen. No project (or a matching one) reads as SAME.
 */
export function classifyCompletionScope(
  agentProjectId: string | null | undefined,
  activeProjectId: string | null | undefined,
): CompletionToastScope {
  return agentProjectId && activeProjectId !== agentProjectId ? "background" : "same";
}

export function buildCompletionToast(input: BuildCompletionToastInput): CompletionToast {
  const scope = classifyCompletionScope(input.agentProjectId, input.activeProjectId);
  const projectId = input.agentProjectId ?? input.activeProjectId ?? undefined;
  // Only ever show a HUMAN label. If none resolves, stay bare ("Done") rather than leaking the raw
  // project id (an internal FNV hash) — matches the voice channel, which omits the repo when unnamed.
  const projectLabel = (projectId ? input.resolveProjectLabel?.(projectId) : null) || null;
  const agentName = (input.agentName ?? "").trim() || "Agent";
  return {
    id: input.eventId,
    dedupeKey: input.agentId || input.eventId,
    agentId: input.agentId || input.eventId,
    agentName,
    agentProjectId: input.agentProjectId ?? undefined,
    projectLabel: projectLabel ?? null,
    scope,
    durationMs: scope === "background" ? BACKGROUND_PROJECT_DURATION_MS : SAME_PROJECT_DURATION_MS,
    createdAt: input.now,
  };
}

/** Add a toast, replacing any existing one for the same agent and moving it to newest (latest-wins).
 *  Returns a new array; never mutates the input. */
export function upsertCompletionToast(list: CompletionToast[], toast: CompletionToast): CompletionToast[] {
  return [...list.filter((t) => t.dedupeKey !== toast.dedupeKey), toast];
}

export interface ToastStackView {
  /** Full cards, oldest→newest (newest rendered closest to the corner). */
  visible: CompletionToast[];
  /** The folded toasts, oldest→newest — revealed as cards when the pile is expanded. */
  collapsed: CompletionToast[];
  /** How many toasts are folded into the pile. */
  collapsedCount: number;
  /** The newest folded toast, shown as the pile's representative row (null when nothing folded). */
  collapsedPreview: CompletionToast | null;
}

/**
 * Split the toast list into the visible cards and a collapsed pile. At or below the cap everything
 * shows; above it the newest `cap - 1` stay as cards and the remainder fold into a pile summarized
 * by its most recent member.
 */
export function selectToastStackView(
  toasts: CompletionToast[],
  maxVisible: number = DEFAULT_MAX_VISIBLE_TOASTS,
): ToastStackView {
  if (toasts.length <= maxVisible) {
    return { visible: toasts, collapsed: [], collapsedCount: 0, collapsedPreview: null };
  }
  const cardCount = Math.max(1, maxVisible - 1);
  const visible = toasts.slice(toasts.length - cardCount);
  const folded = toasts.slice(0, toasts.length - cardCount);
  return {
    visible,
    collapsed: folded,
    collapsedCount: folded.length,
    collapsedPreview: folded[folded.length - 1] ?? null,
  };
}
