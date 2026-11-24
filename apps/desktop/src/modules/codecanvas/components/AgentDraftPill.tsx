"use client";

import { useDraftBatches, type DraftBatch } from "../services/agent-draw/agent-draw-ledger";

/**
 * Minimal Apply/Discard control for agent-drawn draft batches. Follows the canvas terminal
 * visual language (ADR-0033): a single flat, translucent pill floating top-centre — no modal,
 * no panel. Shows the newest pending draft; earlier drafts queue behind it and surface as each
 * is resolved. Renders nothing when there are no drafts.
 */
export interface AgentDraftPillProps {
  onApply: (batch: DraftBatch) => void;
  onDiscard: (batch: DraftBatch) => void;
}

export function AgentDraftPill({ onApply, onDiscard }: AgentDraftPillProps) {
  const batches = useDraftBatches();
  const batch = batches.length ? batches[batches.length - 1] : null;
  if (!batch) return null;

  const who = batch.agentName ? `${batch.agentName} drew` : "Agent drew";
  const queued = batches.length - 1;

  return (
    <div className="canvas-draft-pill" role="group" aria-label="Agent drawing — apply or discard">
      <span className="canvas-draft-pill-summary">
        <span className="canvas-draft-pill-who">{who}</span> {batch.summary}
        {queued > 0 ? <span className="canvas-draft-pill-queued"> · +{queued} more</span> : null}
      </span>
      <button
        type="button"
        className="canvas-draft-pill-btn canvas-draft-pill-apply"
        onClick={() => onApply(batch)}
      >
        Apply
      </button>
      <button
        type="button"
        className="canvas-draft-pill-btn canvas-draft-pill-discard"
        onClick={() => onDiscard(batch)}
      >
        Discard
      </button>
    </div>
  );
}
