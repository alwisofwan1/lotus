"use client";
import { memo } from "react";
import { ListChecks, RefreshCw, Play, Loader2, X } from "lucide-react";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import { stepStatus, planProgress } from "../../services/plan-status";
import { resolveStepAgentId } from "../../services/plan-owner";
import type { PlanSyncStatus } from "../../services/plan-sync";
import type { AgentStatusSnapshot } from "../../services/agent-status-registry";
import type { CanvasOwnerBindings, CanvasPlanStep } from "../../types/canvas";
import { cn } from "@/lib/utils";

export interface PlanNodeCardProps {
  title: string;
  steps: CanvasPlanStep[];
  roster: AgentStatusSnapshot[];
  bindings?: CanvasOwnerBindings;
  syncStatus?: PlanSyncStatus | null;
  onSync: () => void;
  onBindOwner?: (ownerLabel: string, agentId: string | null) => void;
  onClose: () => void;
  onFocus?: () => void;
  onRunPlan?: () => void;
  running?: boolean;
  runError?: string | null;
  runnableCount?: number;
}

function StepOwnerPicker({
  label,
  roster,
  bindings,
  onBind,
}: {
  label: string;
  roster: AgentStatusSnapshot[];
  bindings?: CanvasOwnerBindings;
  onBind?: (ownerLabel: string, agentId: string | null) => void;
}) {
  const boundId = bindings?.[label];
  const unresolved = !resolveStepAgentId(label, roster, bindings);
  if (!onBind) {
    return <span className={cn("plan-step-owner", unresolved && "plan-step-owner--unresolved")}>{label}</span>;
  }
  return (
    <select
      className={cn("plan-step-owner-select", unresolved && "plan-step-owner-select--unresolved")}
      value={boundId ?? ""}
      aria-label={`Owner for ${label}`}
      title={unresolved ? `"${label}" matches no agent — pick one` : `Owner: ${label}`}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onBind(label, e.target.value || null)}
    >
      <option value="">{label}{unresolved ? " ⚠" : ""}</option>
      {roster.map((a) => (
        <option key={a.id} value={a.id}>{a.name}</option>
      ))}
    </select>
  );
}

export const PlanNodeCard = memo(function PlanNodeCard({
  title,
  steps,
  roster,
  bindings,
  syncStatus,
  onSync,
  onBindOwner,
  onClose,
  onFocus,
  onRunPlan,
  running,
  runError,
  runnableCount,
}: PlanNodeCardProps) {
  const progress = planProgress(steps, roster, bindings);
  const unresolvedCount = steps.filter((step) => step.owner && !resolveStepAgentId(step.owner, roster, bindings)).length;
  const resolvedOwners = new Set(steps.map((step) => resolveStepAgentId(step.owner, roster, bindings)).filter(Boolean));
  const runnableOwners = runnableCount ?? resolvedOwners.size;
  const canRun = runnableOwners > 0;
  return (
    <div className="plan-card">
      <div className="canvas-node-header plan-card-header">
        <span className="canvas-node-header-label plan-card-identity">
          <ListChecks size={13} className="plan-card-glyph" aria-hidden />
          <span className="plan-card-title">{title}</span>
        </span>
        <div className="canvas-node-actions">
          {onFocus && (
            <CanvasNodeFocusAction onFocus={onFocus} className="canvas-node-close canvas-node-focus" />
          )}
          <button className="canvas-node-close" aria-label={`Close ${title}`} onClick={onClose}>
            <X size={11} aria-hidden />
          </button>
        </div>
      </div>

      <div className="plan-card-progress">
        <div className="plan-card-bar"><span style={{ width: `${Math.round(progress.ratio * 100)}%` }} /></div>
        <span className="plan-card-count">{progress.done}/{progress.total}</span>
        <button className="plan-card-sync" aria-label="Sync from plan.md" onClick={onSync}>
          <RefreshCw size={11} aria-hidden /> Sync
        </button>
        {onRunPlan && (
          <button
            className="plan-card-run"
            aria-label="Run plan"
            disabled={running || !canRun}
            title={canRun ? `Run ${runnableOwners} owner agent${runnableOwners === 1 ? "" : "s"}` : "No step owner matches a live agent"}
            onClick={onRunPlan}
          >
            {running ? <Loader2 size={11} className="canvas-run-spin" aria-hidden /> : <Play size={11} aria-hidden />} Run
          </button>
        )}
      </div>

      {(runnableOwners > 0 || unresolvedCount > 0) && (
        <div className="plan-card-routing" aria-label="Plan routing summary">
          {runnableOwners > 0 && <span className="plan-card-route-chip">{runnableOwners} runnable owner{runnableOwners === 1 ? "" : "s"}</span>}
          {unresolvedCount > 0 && <span className="plan-card-route-chip plan-card-route-chip--warn">{unresolvedCount} unbound</span>}
        </div>
      )}

      {runError && <p className="plan-card-run-error" role="alert">{runError}</p>}

      {syncStatus && (
        <p className={`plan-card-sync-status plan-card-sync-status--${syncStatus.kind}`} role="status">
          {syncStatus.message}
        </p>
      )}

      <div className="plan-card-body nodrag nowheel">
        {steps.length === 0 ? (
          <p className="plan-card-empty">No steps — run the Lead, then Sync from <code>plan.md</code>.</p>
        ) : (
          <ul className="plan-card-steps">
            {steps.map((step, i) => {
              const status = stepStatus(step, roster, bindings);
              return (
                <li key={`${i}-${step.title}`} className={`plan-step plan-step--${status}`}>
                  <span className={`plan-step-dot plan-step-dot--${status}`} aria-hidden />
                  <span className="plan-step-title">{step.title}</span>
                  {step.owner && (
                    <StepOwnerPicker label={step.owner} roster={roster} bindings={bindings} onBind={onBindOwner} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
});
