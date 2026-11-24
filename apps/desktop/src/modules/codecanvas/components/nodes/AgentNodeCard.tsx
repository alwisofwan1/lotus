"use client";
import { memo, useState } from "react";
import { Bot, Play, Square, SendHorizontal, History } from "lucide-react";
import type { AgentNodeStatus } from "../../types/canvas";
import type { AgentRunView } from "../../services/agent-run-view";
import { AgentRunTranscript } from "./AgentRunTranscript";
import { AgentNodeActionBar } from "./AgentNodeActionBar";

export interface AgentNodeCardProps {
  name: string;
  model: string;
  status: AgentNodeStatus;
  view: AgentRunView;
  canReply: boolean;
  readonly?: boolean;
  /** Claude session id for the current/last run — shown truncated for resume/debug. */
  sessionId?: string | null;
  contextCount?: number;
  skillCount?: number;
  imageCount?: number;
  worktreeBranch?: string | null;
  onRun: () => void;
  onStop: () => void;
  onClose: () => void;
  onFocus?: () => void;
  onReply: (text: string) => void;
  onShowHistory?: () => void;
  // Canvas Agent Action Bar — optional tool affordances; each button appears only when wired.
  onToggleWT?: () => void;
  wtActive?: boolean;
  onToggleDiff?: () => void;
  diffActive?: boolean;
  onOpenIde?: () => void;
  onToggleSkills?: () => void;
  skillsActive?: boolean;
  onPromoteToTerminal?: () => void;
  deliveryTargetId?: string;
}

const DOT: Record<AgentNodeStatus, string> = {
  idle: "idle",
  connecting: "starting",
  running: "running",
  "needs-you": "needs-you",
  completed: "live",
  error: "failed",
  stalled: "stalled",
};

const isBusy = (s: AgentNodeStatus) => s === "connecting" || s === "running";

export const AgentNodeCard = memo(function AgentNodeCard({
  name,
  model,
  status,
  view,
  canReply,
  readonly,
  onRun,
  onStop,
  onClose,
  onFocus,
  onReply,
  onShowHistory,
  onToggleWT,
  wtActive,
  onToggleDiff,
  diffActive,
  onOpenIde,
  onToggleSkills,
  skillsActive,
  onPromoteToTerminal,
  deliveryTargetId,
  sessionId,
  contextCount = 0,
  skillCount = 0,
  imageCount = 0,
  worktreeBranch,
}: AgentNodeCardProps) {
  const busy = isBusy(status);
  const [reply, setReply] = useState("");
  const submitReply = () => {
    const text = reply.trim();
    if (!text) return;
    onReply(text);
    setReply("");
  };
  return (
    <div className="agent-card">
      <div className="canvas-node-header agent-card-header">
        <span className="canvas-node-header-label agent-card-identity">
          <span className="canvas-node-chip" aria-hidden>
            <Bot size={13} />
          </span>
          <span className="agent-card-name">{name}</span>
        </span>
        <AgentNodeActionBar
          onClose={onClose}
          onFocus={onFocus}
          onToggleWT={onToggleWT}
          wtActive={wtActive}
          onToggleDiff={onToggleDiff}
          diffActive={diffActive}
          onOpenIde={onOpenIde}
          onToggleSkills={onToggleSkills}
          skillsActive={skillsActive}
          onPromoteToTerminal={onPromoteToTerminal}
          promoteToTerminalDisabled={busy}
        />
      </div>

      <div className="agent-card-meta">
        <span className="agent-card-meta-left">
          <span className="agent-card-model">{model}</span>
          {sessionId && (
            <span className="agent-card-session" title={sessionId}>{sessionId.slice(0, 8)}</span>
          )}
          {readonly && <span className="agent-card-readonly" title="Safe mode: read-only, no writes">read-only</span>}
        </span>
        <span key={status} className={`agent-status agent-status--${status}`} aria-label={`Status: ${status}`}>
          <span className={`cth-dot cth-dot--${DOT[status]}`} aria-hidden />
          <span className="agent-status-label">{status}</span>
        </span>
      </div>

      {(contextCount > 0 || skillCount > 0 || imageCount > 0 || worktreeBranch) && (
        <div className="agent-card-context" aria-label="Run inputs">
          {contextCount > 0 && <span className="agent-card-chip" title="Connected notes used as context">context {contextCount}</span>}
          {skillCount > 0 && <span className="agent-card-chip" title="Skills injected into the run prompt">skills {skillCount}</span>}
          {imageCount > 0 && <span className="agent-card-chip" title="Images delivered to the next run">images {imageCount}</span>}
          {worktreeBranch && <span className="agent-card-chip agent-card-chip--worktree" title="Assigned worktree">WT {worktreeBranch}</span>}
        </div>
      )}

      <div className="agent-card-body">
        <AgentRunTranscript view={view} status={status} />
      </div>

      {canReply && (
        <div className="agent-card-reply nodrag" data-canvas-agent-delivery-target={deliveryTargetId}>
          <input
            className="agent-card-reply-input"
            aria-label="Reply to agent"
            placeholder="Reply to continue…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitReply(); }}
          />
          <button className="agent-card-reply-send" aria-label="Send reply" disabled={!reply.trim()} onClick={submitReply}>
            <SendHorizontal size={12} aria-hidden />
          </button>
        </div>
      )}

      <div className="agent-card-actions">
        {busy ? (
          <button className="agent-btn agent-btn--stop" aria-label="Stop agent" onClick={onStop}>
            <Square size={11} aria-hidden /> Stop
          </button>
        ) : (
          <button className="agent-btn agent-btn--run" aria-label="Run agent" onClick={onRun}>
            <Play size={11} aria-hidden /> {status === "completed" || status === "error" ? "Re-run" : "Run"}
          </button>
        )}
        {onShowHistory && (
          <button className="agent-btn agent-btn--history" aria-label="Run history" onClick={onShowHistory}>
            <History size={11} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
});
