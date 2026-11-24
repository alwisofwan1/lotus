"use client";
// occlusion-exempt: a small non-blocking inline chip (role="note"), not a modal, menu or dialog; it parks nothing.
import { SquareDashed, X } from "lucide-react";
import { suggestionText, type FrameSuggestion } from "../services/canvas-frame-suggestion";

interface Props {
  suggestion: FrameSuggestion;
  onAccept: () => void;
  onDismiss: () => void;
}

/** Frame Suggestion (decision 26): one click makes a Frame from exactly the suggested nodes. */
export function CanvasFrameSuggestion({ suggestion, onAccept, onDismiss }: Props) {
  return (
    <aside className="canvas-frame-suggestion" role="note" aria-label="Frame suggestion" data-testid="frame-suggestion">
      <SquareDashed size={15} aria-hidden="true" />
      <span className="canvas-frame-suggestion-text">{suggestionText(suggestion)}</span>
      <button type="button" className="canvas-frame-suggestion-ok" onClick={onAccept}>Jadikan Frame</button>
      <button type="button" className="canvas-frame-suggestion-x" onClick={onDismiss} aria-label="Dismiss suggestion"><X size={14} aria-hidden="true" /></button>
    </aside>
  );
}
