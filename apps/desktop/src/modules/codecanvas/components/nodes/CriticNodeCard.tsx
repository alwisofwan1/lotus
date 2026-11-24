"use client";
import { memo } from "react";
import { ShieldCheck, Play, Square, X } from "lucide-react";
import type { AgentNodeStatus } from "../../types/canvas";
import type { CriticVerdict } from "../../services/critic-verdict";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";

interface Props {
  title: string;
  status: AgentNodeStatus;
  verdict: CriticVerdict | null;
  onTitleChange: (title: string) => void;
  onRun: () => void;
  onStop: () => void;
  onClose: () => void;
  onFocus?: () => void;
}

const busy = (s: AgentNodeStatus) => s === "connecting" || s === "running";

/** Presentational surface of a Critic gate: title, run control, and its latest verdict. */
export const CriticNodeCard = memo(function CriticNodeCard({ title, status, verdict, onTitleChange, onRun, onStop, onClose, onFocus }: Props) {
  return (
    <div className="canvas-critic">
      <div className="canvas-critic-head">
        <ShieldCheck size={13} aria-hidden className="canvas-critic-icon" />
        <input
          className="canvas-critic-title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          aria-label="Critic name"
        />
        {onFocus && <CanvasNodeFocusAction onFocus={onFocus} className="canvas-critic-close canvas-node-focus" iconSize={12} />}
        <button className="canvas-critic-close" onClick={onClose} aria-label="Close critic node">
          <X size={12} aria-hidden />
        </button>
      </div>
      <p className="canvas-critic-hint">Gates downstream: verifies upstream work and blocks it on FAIL.</p>
      <div className="canvas-critic-foot">
        {verdict && (
          <span className={`canvas-critic-verdict canvas-critic-verdict--${verdict}`} aria-label={`Verdict: ${verdict}`}>
            {verdict === "pass" ? "PASS" : "FAIL"}
          </span>
        )}
        <span className={`canvas-critic-status canvas-critic-status--${status}`}>{status}</span>
        {busy(status) ? (
          <button className="canvas-critic-btn" onClick={onStop} aria-label="Stop critic"><Square size={11} aria-hidden /> Stop</button>
        ) : (
          <button className="canvas-critic-btn" onClick={onRun} aria-label="Run critic"><Play size={11} aria-hidden /> Verify</button>
        )}
      </div>
    </div>
  );
});
