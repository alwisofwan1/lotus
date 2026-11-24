"use client";
import { memo } from "react";
import { X } from "lucide-react";
import type { ContextArtifact } from "../../services/context-bus-record";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";

interface Props {
  title: string;
  artifacts: ContextArtifact[];
  onTitleChange: (title: string) => void;
  onClose: () => void;
  onFocus?: () => void;
}

/** Presentational surface of one Context Bus: editable title + the artifacts agents published. */
export const ContextNodeCard = memo(function ContextNodeCard({ title, artifacts, onTitleChange, onClose, onFocus }: Props) {
  return (
    <div className="canvas-context">
      <div className="canvas-context-head">
        <input
          className="canvas-context-title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          aria-label="Context bus name"
        />
        {onFocus && <CanvasNodeFocusAction onFocus={onFocus} className="canvas-context-close canvas-node-focus" iconSize={12} />}
        <button className="canvas-context-close" onClick={onClose} aria-label="Close context node">
          <X size={12} aria-hidden />
        </button>
      </div>
      {artifacts.length === 0 ? (
        <p className="canvas-context-empty">No artifacts yet. Wire an agent in (data-flow) to publish its result here.</p>
      ) : (
        <ul className="canvas-context-list">
          {artifacts.map((a) => (
            <li key={a.id} className="canvas-context-item">
              <div className="canvas-context-item-head">
                <span className="canvas-context-key">{a.key}</span>
                <span className="canvas-context-meta">v{a.version} · {a.producer}</span>
              </div>
              <p className="canvas-context-value">{a.value}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
