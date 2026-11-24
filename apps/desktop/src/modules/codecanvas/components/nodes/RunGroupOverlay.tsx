"use client";
import { memo, useState } from "react";
import { ViewportPortal } from "@xyflow/react";
import { ChevronDown } from "lucide-react";
import { BudgetMeter, RunCardAction, RunDecisionPanel, metaParts, useRunDecision } from "./RunNodeCard";
import { RunNodeMenu } from "./RunNodeMenu";
import { RUN_CARD_TONE, runCardLabel, type RunCardView } from "../../services/run-node";
import type { RunGroupBox } from "../../services/run-group";

export interface RunGroupOverlayProps {
  box: RunGroupBox;
  title: string;
  view: RunCardView;
  memberCount: number;
  hasGoal: boolean;
  error: string | null;
  /** Zoomed out below the full tier: the header shows dot + title only, like the glyph. */
  compact: boolean;
  onCollapse: () => void;
  onRun: () => void;
  onResume?: () => void;
  onRaiseCap?: () => void;
  onShip?: () => void;
  onSendBack?: () => void;
  sendBackBlocked?: string;
  onPause?: () => void;
  onAbort?: () => void;
}

/**
 * An open Run Node (#74, mockups/lotus-graph-run.pen S9): a rounded outline around the members with
 * the run's header on top. Drawn in flow coordinates through `ViewportPortal`, not as a node —
 * autosave would save a fake node. The outline body lets the pointer through to the members; only
 * the header takes clicks.
 */
export const RunGroupOverlay = memo(function RunGroupOverlay({
  box, title, view, memberCount, hasGoal, error, compact, onCollapse, onRun, onResume, onRaiseCap, onShip, onSendBack, sendBackBlocked, onPause, onAbort,
}: RunGroupOverlayProps) {
  const [focused, setFocused] = useState(false);
  const decision = useRunDecision({ view, selected: focused, onShip, onSendBack, sendBackBlocked, onRaiseCap });
  const active = view.state === "running" || view.state === "waiting" || view.state === "pausing" || view.state === "paused";

  return (
    <ViewportPortal>
      <div
        className="run-group"
        data-run-state={view.state}
        data-tone={RUN_CARD_TONE[view.state]}
        data-testid="run-group"
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      >
        <div
          className="run-group-head nodrag nopan nowheel"
          role="group"
          aria-label={`${title} — ${runCardLabel(view)}`}
          tabIndex={0}
          onFocus={() => setFocused(true)}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setFocused(false); }}
        >
          {compact ? null : (
            <button type="button" className="run-card-icon" aria-label="Collapse run" title="Collapse run" onClick={onCollapse}>
              <ChevronDown size={14} aria-hidden />
            </button>
          )}
          <span className="run-card-dot" aria-hidden />
          <div className="run-group-name">
            <span className="run-card-title" title={title}>{title}</span>
            {compact ? null : (
              <span className="run-card-meta">
                <span className="run-card-status">{runCardLabel(view)}</span>
                {metaParts(view, memberCount).map((part) => (
                  <span key={part} className="run-card-meta-part">· {part}</span>
                ))}
              </span>
            )}
          </div>
          {compact ? null : (
            <>
              {view.budgetCap != null ? (
                <div className="run-group-budget"><BudgetMeter view={view} cap={view.budgetCap} /></div>
              ) : null}
              <RunCardAction
                view={view} memberCount={memberCount} hasGoal={hasGoal} raisable={decision.raisable}
                onDecide={decision.openDecision} onRaiseCap={onRaiseCap} onRun={onRun} onResume={onResume}
              />
              <RunNodeMenu onPause={onPause} onAbort={onAbort} />
            </>
          )}
        </div>
        {!compact && decision.decisionOpen && view.gate ? (
          <div className="run-group-decision nodrag nopan">
            <RunDecisionPanel
              gate={view.gate} canSendBack={decision.canSendBack} sendBackBlocked={sendBackBlocked}
              onShip={decision.ship} onSendBack={decision.sendBack} onClose={decision.closeDecision}
            />
          </div>
        ) : null}
        {!compact && error ? <p className="run-card-error run-group-error" role="alert">{error}</p> : null}
        {!compact && !active ? <p className="run-group-hint">Drag a node in or out to change the run.</p> : null}
      </div>
    </ViewportPortal>
  );
});
