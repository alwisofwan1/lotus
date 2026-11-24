"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import type { FrameDeletionSummary } from "../services/canvas-frames";
import { useCanvasOcclusionLock } from "../hooks/useCanvasOcclusionLock";

interface Props {
  frameTitle: string;
  summary: FrameDeletionSummary;
  onCancel: () => void;
  /** Keep the nodes, delete only the Frame (undoable). */
  onDeleteFrameOnly: () => void;
  /** Delete the Frame and every node in it. Not undoable. */
  onDeleteAll: () => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "This stops 1 running terminal and 1 agent." / "This closes its 2 nodes." */
function consequence(s: FrameDeletionSummary): string {
  const live: string[] = [];
  if (s.terminals > 0) live.push(`${plural(s.terminals, "running terminal")}`);
  if (s.agents > 0) live.push(plural(s.agents, "agent"));
  const stops = live.length > 0 ? `This stops ${live.join(" and ")}. Their sessions end and ` : "This ";
  return `${stops}cannot be brought back by Undo.`;
}

/**
 * Confirm for "Delete with contents" (decision 21). Says outright that it is NOT undoable and
 * shows how many terminals and agents die with it. Cancel has initial focus: the safe answer is
 * the one Enter picks.
 */
export function CanvasFrameDeleteDialog({ frameTitle, summary, onCancel, onDeleteFrameOnly, onDeleteAll }: Props) {
  useCanvasOcclusionLock(true, "frame-delete-dialog");
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const title = frameTitle || "Frame";
  return createPortal(
    <div className="canvas-frame-dialog-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="canvas-frame-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-frame-dialog-title" data-testid="frame-delete-dialog">
        <div className="canvas-frame-dialog-head">
          <span className="canvas-frame-dialog-icon" aria-hidden="true"><Trash2 size={18} /></span>
          <div>
            <h2 id="canvas-frame-dialog-title">{`Delete “${title}” and its ${plural(summary.nodeCount, "node")}?`}</h2>
            <p data-testid="frame-delete-consequence">{consequence(summary)}</p>
          </div>
        </div>
        {summary.terminals + summary.agents > 0 ? (
          <ul className="canvas-frame-dialog-list" aria-label="Sessions that will end">
            {summary.terminals > 0 ? <li><span>{plural(summary.terminals, "terminal")}</span><span>running</span></li> : null}
            {summary.agents > 0 ? <li><span>{plural(summary.agents, "agent")}</span><span>will stop</span></li> : null}
          </ul>
        ) : null}
        <div className="canvas-frame-dialog-actions">
          <button type="button" className="canvas-frame-dialog-btn canvas-frame-dialog-btn--quiet" onClick={onDeleteFrameOnly}>
            Delete Frame only
          </button>
          <button ref={cancelRef} type="button" className="canvas-frame-dialog-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="canvas-frame-dialog-btn canvas-frame-dialog-btn--danger" onClick={onDeleteAll}>
            {`Delete Frame + ${plural(summary.nodeCount, "node")}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
