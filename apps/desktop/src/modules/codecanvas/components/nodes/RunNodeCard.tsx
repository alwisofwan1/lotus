"use client";
import { memo, useCallback, useEffect, useState } from "react";
import { ArrowUp, ChevronRight, Hand, Play, RotateCcw, StepForward, X } from "lucide-react";
import { glyphInitials } from "./CanvasNodeGlyph";
import { isEditableCanvasKeyTarget } from "../../services/canvas-keyboard-guard";
import { RunNodeMenu } from "./RunNodeMenu";
import {
  RUN_CARD_TONE,
  formatRunElapsed,
  normalizeBudgetCap,
  pausedAtBudget,
  runCardLabel,
  type RunCardView,
} from "../../services/run-node";

export interface RunMember {
  id: string;
  label: string;
}

export interface RunNodeCardProps {
  title: string;
  view: RunCardView;
  members: RunMember[];
  /** Dispatch order (`runChainLabel`); defaults to the members in a row. */
  chain?: string;
  /** The run's goal; each live agent gets it as its step. */
  brief: string;
  error: string | null;
  onBriefChange: (brief: string) => void;
  onRun: () => void;
  /** Set when an interrupted run can continue from its checkpoint (#73): the one action becomes Resume. */
  onResume?: () => void;
  /** Sets the run's USD cap; `undefined` removes it. */
  onBudgetCapChange: (cap: number | undefined) => void;
  /** Raises the cap of a run paused at it and continues — the paused card's one action. */
  onRaiseCap?: () => void;
  /** Approves the waiting gate (`view.gate`). */
  onShip?: () => void;
  /** Rejects the waiting gate and re-runs its author once the run settles. */
  onSendBack?: () => void;
  /** Why Send back is unavailable for this gate; set = the option is disabled. */
  sendBackBlocked?: string;
  /** Selected on the board: Enter / 1 / 2 / Esc act on this card only then. */
  selected?: boolean;
  onClose: () => void;
  /** Draws the run as an outline around its members (#74). */
  onOpen?: () => void;
  /** ⋯ Pause (#114); set only while the run can be paused. */
  onPause?: () => void;
  /** ⋯ Abort (#114); set only while there is a run to end. */
  onAbort?: () => void;
}

const MAX_AVATARS = 4;

const usd = (n: number) => `$${n.toFixed(2)}`;
const steps = (n: number) => `${n} step${n === 1 ? "" : "s"}`;

/** `$spent / $cap` — read against the cap, an unknown spend counts as nothing spent yet. */
function budgetLabel(view: RunCardView, cap: number): string {
  return `${usd(view.costUsd ?? 0)} / ${usd(cap)}`;
}

export function metaParts(view: RunCardView, memberCount: number): string[] {
  const parts = [`${memberCount} node${memberCount === 1 ? "" : "s"}`];
  if (view.elapsedMs != null) parts.push(formatRunElapsed(view.elapsedMs));
  // With a cap the meter carries `$spent / $cap` — once, also when paused (#76 fix 3).
  if (view.budgetCap == null && view.costUsd != null) parts.push(usd(view.costUsd));
  if (view.unknownCostSteps > 0) parts.push(`cost unknown · ${steps(view.unknownCostSteps)}`);
  if (view.moreWaiting > 0) parts.push(`+${view.moreWaiting} waiting`);
  return parts;
}

/** Ticket ac1 `$used ▬── $cap`: separate from the progress rail, full (and amber) at the cap. */
export function BudgetMeter({ view, cap }: { view: RunCardView; cap: number }) {
  const spent = view.costUsd ?? 0;
  const fill = Math.min(100, Math.round((spent / cap) * 100));
  return (
    <>
      <div
        className="run-card-meter"
        role="meter"
        aria-label="Budget"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(spent, cap)}
        data-full={spent >= cap ? "" : undefined}
      >
        <span style={{ width: `${fill}%` }} />
      </div>
      <span className="run-card-budget-text">{budgetLabel(view, cap)}</span>
    </>
  );
}

/** Edits commit on blur or Enter; remounted by `key` when the cap changes from outside (Raise cap). */
function BudgetCapInput({ cap, readOnly, onChange }: { cap: number | null; readOnly: boolean; onChange: (cap: number | undefined) => void }) {
  const commit = (input: HTMLInputElement) => {
    const next = input.value.trim() === "" ? undefined : normalizeBudgetCap(Number(input.value));
    input.value = next === undefined ? "" : next.toFixed(2);
    if (next !== (cap ?? undefined)) onChange(next);
  };
  return (
    <label className="run-card-cap nodrag" title={readOnly ? "The cap is fixed while the run is live" : "Pause the run once it has spent this much (USD). Empty = no cap."}>
      <span aria-hidden>Cap $</span>
      <input
        key={cap ?? "none"}
        aria-label="Budget cap (USD)"
        inputMode="decimal"
        placeholder="none"
        defaultValue={cap == null ? "" : cap.toFixed(2)}
        readOnly={readOnly}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      />
    </label>
  );
}

/**
 * Closed Run Node card (mockups/lotus-graph-run.pen S8): status dot + title / meta line with the
 * status word in `-ink` / members / progress rail / avatars + ONE action. Colour is never the only
 * signal — the status word always sits beside the dot.
 */
/** The decision panel and the Enter keys, shared by the card and the open group's header (#74). */
export function useRunDecision({ view, selected, onShip, onSendBack, sendBackBlocked, onRaiseCap }: {
  view: RunCardView;
  /** The card is selected, or the group header has focus: only then do the keys act. */
  selected: boolean;
  onShip?: () => void;
  onSendBack?: () => void;
  sendBackBlocked?: string;
  onRaiseCap?: () => void;
}) {
  const waiting = view.state === "waiting";
  const raisable = pausedAtBudget(view) && !!onRaiseCap;
  const [deciding, setDeciding] = useState(false);
  const decisionOpen = deciding && waiting && view.gate !== null;
  const canSendBack = !!onSendBack && !sendBackBlocked;
  const ship = useCallback(() => { setDeciding(false); onShip?.(); }, [onShip]);
  const sendBack = useCallback(() => {
    if (!canSendBack) return;
    setDeciding(false);
    onSendBack?.();
  }, [canSendBack, onSendBack]);

  // ⌥digits are left alone on purpose: they belong to run switching (plans/canvas-graph-run P6).
  useEffect(() => {
    if (!selected || !waiting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey || e.ctrlKey || isEditableCanvasKeyTarget(e.target)) return;
      if (!decisionOpen) {
        if (e.key !== "Enter") return;
        setDeciding(true);
      } else if (e.key === "1") ship();
      else if (e.key === "2") sendBack();
      else if (e.key === "Escape") setDeciding(false);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, waiting, decisionOpen, ship, sendBack]);

  useEffect(() => {
    if (!selected || !raisable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.altKey || e.metaKey || e.ctrlKey || isEditableCanvasKeyTarget(e.target)) return;
      e.preventDefault();
      onRaiseCap?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, raisable, onRaiseCap]);

  return {
    decisionOpen, raisable, canSendBack, ship, sendBack,
    openDecision: useCallback(() => setDeciding(true), []),
    closeDecision: useCallback(() => setDeciding(false), []),
  };
}

export function RunDecisionPanel({ gate, canSendBack, sendBackBlocked, onShip, onSendBack, onClose }: {
  gate: NonNullable<RunCardView["gate"]>;
  canSendBack: boolean;
  sendBackBlocked?: string;
  onShip: () => void;
  onSendBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="run-decision nodrag nowheel" role="group" aria-label={`Decide: ${gate.title}`}>
      <div className="run-decision-head">
        <span className="run-decision-title" title={gate.title}>{gate.title}</span>
        <button type="button" className="run-card-icon nodrag" aria-label="Close decision" title="Close (Esc)" onClick={onClose}>
          <X size={12} aria-hidden />
        </button>
      </div>
      {gate.instructions ? <p className="run-decision-instructions">{gate.instructions}</p> : null}
      <div className="run-decision-options">
        <button type="button" className="run-decision-option nodrag" onClick={onShip} title="Approve the gate and let the run continue">
          <kbd>1</kbd>Ship
        </button>
        <button type="button" className="run-decision-option nodrag" onClick={onSendBack} disabled={!canSendBack} title={sendBackBlocked ?? "Reject the gate and run its author again"}>
          <kbd>2</kbd>Send back
        </button>
      </div>
    </div>
  );
}

/** The run's ONE action: Decide / Raise cap (filled) or Run / Resume / Run again (outline). */
export function RunCardAction({ view, memberCount, hasGoal, raisable, onDecide, onRaiseCap, onRun, onResume }: {
  view: RunCardView;
  memberCount: number;
  hasGoal: boolean;
  raisable: boolean;
  onDecide: () => void;
  onRaiseCap?: () => void;
  onRun: () => void;
  onResume?: () => void;
}) {
  const waiting = view.state === "waiting";
  const pausing = view.state === "pausing";
  const live = view.state === "running" || waiting || pausing;
  const fresh = view.state === "idle";
  const resumable = (view.state === "interrupted" || view.state === "paused") && !!onResume;
  if (waiting) {
    return (
      <button type="button" className="run-card-action run-card-action--filled nodrag" onClick={onDecide} title="Decide the waiting gate (Enter)">
        <Hand size={12} aria-hidden />
        Decide
        {view.waitingMs != null ? <span className="run-card-action-timer">{formatRunElapsed(view.waitingMs)}</span> : null}
        <kbd aria-hidden>↵</kbd>
      </button>
    );
  }
  if (raisable) {
    return (
      <button type="button" className="run-card-action run-card-action--filled nodrag" onClick={onRaiseCap} title="Raise the cap by half and continue from the last finished step (Enter)">
        <ArrowUp size={12} aria-hidden />
        Raise cap
        <kbd aria-hidden>↵</kbd>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="run-card-action nodrag"
      onClick={resumable ? onResume : onRun}
      disabled={live || memberCount === 0 || !hasGoal}
      title={hasGoal ? (resumable ? "Continue from the last finished step" : undefined) : "Write a goal first"}
    >
      {resumable ? <StepForward size={12} aria-hidden /> : fresh ? <Play size={12} aria-hidden /> : <RotateCcw size={12} aria-hidden />}
      {pausing ? "Pausing…" : live ? "Running…" : resumable ? "Resume" : fresh ? "Run" : "Run again"}
    </button>
  );
}

/**
 * Closed Run Node card (mockups/lotus-graph-run.pen S8): status dot + title / meta line with the
 * status word in `-ink` / members / progress rail / avatars + ONE action. Colour is never the only
 * signal — the status word always sits beside the dot.
 */
export const RunNodeCard = memo(function RunNodeCard({ title, view, members, chain: order, brief, error, onBriefChange, onRun, onResume, onBudgetCapChange, onRaiseCap, onShip, onSendBack, sendBackBlocked, selected = false, onClose, onOpen, onPause, onAbort }: RunNodeCardProps) {
  const tone = RUN_CARD_TONE[view.state];
  const live = view.state === "running" || view.state === "waiting" || view.state === "pausing";
  const progress = view.total > 0 ? Math.round((view.finished / view.total) * 100) : 0;
  const chain = members.length > 0 ? order ?? members.map((m) => m.label).join(", ") : "No members — this run has nothing to dispatch.";
  const hasGoal = brief.trim().length > 0;
  const decision = useRunDecision({ view, selected, onShip, onSendBack, sendBackBlocked, onRaiseCap });

  return (
    <div className="run-card" data-run-state={view.state} data-tone={tone}>
      <div className="run-card-head">
        <span className="run-card-dot" aria-hidden />
        <span className="run-card-title" title={title}>{title}</span>
        {onOpen ? (
          <button type="button" className="run-card-icon nodrag" aria-label="Open as group" title="Open as group" onClick={onOpen}>
            <ChevronRight size={13} aria-hidden />
          </button>
        ) : null}
        <RunNodeMenu onPause={onPause} onAbort={onAbort} />
        <button type="button" className="run-card-icon nodrag" aria-label="Remove run" title="Remove run" onClick={onClose}>
          <X size={13} aria-hidden />
        </button>
      </div>
      <div className="run-card-meta">
        <span className="run-card-status">{runCardLabel(view)}</span>
        {metaParts(view, members.length).map((part) => (
          <span key={part} className="run-card-meta-part">· {part}</span>
        ))}
      </div>
      {decision.decisionOpen && view.gate ? (
        <RunDecisionPanel
          gate={view.gate} canSendBack={decision.canSendBack} sendBackBlocked={sendBackBlocked}
          onShip={decision.ship} onSendBack={decision.sendBack} onClose={decision.closeDecision}
        />
      ) : (
        <>
          <textarea
            className="run-card-goal nodrag nowheel"
            aria-label="Run goal"
            placeholder="Goal — what should this run achieve? Each agent gets it as its step."
            value={brief}
            readOnly={live}
            onChange={(e) => onBriefChange(e.target.value)}
          />
          <p className="run-card-chain" title={chain}>{chain}</p>
        </>
      )}
      {error ? <p className="run-card-error" role="alert">{error}</p> : null}
      <div
        className="run-card-rail"
        role="progressbar"
        aria-label="Run progress"
        aria-valuemin={0}
        aria-valuemax={view.total}
        aria-valuenow={view.finished}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="run-card-budget">
        {view.budgetCap != null ? <BudgetMeter view={view} cap={view.budgetCap} /> : null}
        <BudgetCapInput cap={view.budgetCap} readOnly={live} onChange={onBudgetCapChange} />
      </div>
      <div className="run-card-foot">
        <div className="run-card-avatars" aria-label={`${members.length} members`}>
          {members.slice(0, MAX_AVATARS).map((m) => (
            <span key={m.id} className="run-card-avatar" title={m.label}>{glyphInitials(m.label)}</span>
          ))}
          {members.length > MAX_AVATARS ? <span className="run-card-avatar run-card-avatar--more">+{members.length - MAX_AVATARS}</span> : null}
        </div>
        <span className="run-card-count">{view.finished}/{view.total}</span>
        <RunCardAction
          view={view} memberCount={members.length} hasGoal={hasGoal} raisable={decision.raisable}
          onDecide={decision.openDecision} onRaiseCap={onRaiseCap} onRun={onRun} onResume={onResume}
        />
      </div>
    </div>
  );
});

/** Zoomed-out stand-in (below the glyph LOD threshold): status dot + title only. */
export const RunNodeGlyph = memo(function RunNodeGlyph({ title, view }: { title: string; view: RunCardView }) {
  return (
    <div className="run-glyph" data-run-state={view.state} data-tone={RUN_CARD_TONE[view.state]} role="img" aria-label={`${title} — ${runCardLabel(view)}`} title={title}>
      <span className="run-card-dot" aria-hidden />
      <span className="run-glyph-title">{title}</span>
    </div>
  );
});
