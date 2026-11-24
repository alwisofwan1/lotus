"use client";
import { useEffect, useState } from "react";
import { X, GitCompare } from "lucide-react";
import { getActiveProjectLocation } from "../../services/canvas-active-project";
import { uncommittedDiffFor } from "../../services/remote-git";
import { parseDiffLines } from "../../services/diff-lines";

export interface AgentDiffPanelProps {
  /** The agent's run directory (its assigned worktree, else its base cwd). */
  cwd: string;
  onClose: () => void;
  /**
   * Injectable diff source; defaults to `git diff HEAD` on whichever machine the project is on.
   *
   * The agent's worktree is on that machine, so asking this one would either find nothing or —
   * worse, if a path happens to exist here — show somebody else's changes.
   */
  loadDiff?: (cwd: string) => Promise<string>;
}

const diffOnProjectMachine = (cwd: string) => uncommittedDiffFor(getActiveProjectLocation(), cwd);

export function AgentDiffPanel({ cwd, onClose, loadDiff = diffOnProjectMachine }: AgentDiffPanelProps) {
  const [diff, setDiff] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadDiff(cwd)
      .then((d) => { if (alive) setDiff(d); })
      .catch(() => { if (alive) setDiff(""); });
    return () => { alive = false; };
  }, [cwd, loadDiff]);

  const lines = diff ? parseDiffLines(diff) : [];

  return (
    <div className="canvas-panel agent-diff-panel nodrag nopan nowheel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="canvas-panel-header">
        <span className="canvas-panel-title">
          <GitCompare size={11} aria-hidden />
          Uncommitted changes
        </span>
        <button className="canvas-panel-icon-btn" aria-label="Close panel" onClick={onClose}>
          <X size={11} />
        </button>
      </div>

      <div className="canvas-panel-body agent-diff-body">
        {diff === null && <p className="canvas-panel-empty">Loading…</p>}
        {diff !== null && lines.length === 0 && (
          <p className="canvas-panel-empty">No uncommitted changes vs HEAD.</p>
        )}
        {lines.length > 0 && (
          <pre className="agent-diff-pre">
            {lines.map((line, i) => (
              <code key={i} className={`agent-diff-line agent-diff-line--${line.kind}`}>
                {line.text || " "}
              </code>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
