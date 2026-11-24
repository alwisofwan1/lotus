"use client";
import { memo } from "react";
import { Scan } from "lucide-react";

interface CanvasNodeFocusActionProps {
  /** Toggle focus mode (hero + right rail) on this node. */
  onFocus: () => void;
  /**
   * Local chrome class so the action blends with each node's header idiom (terminal `cth-action`,
   * browser `cbk-btn`, note/task `canvas-node-close`, …). The Scan glyph is the constant signifier
   * that keeps the affordance reading identically across every node type.
   */
  className?: string;
  iconSize?: number;
}

/**
 * The shared "focus this node" chrome action. One icon (Scan) + one behaviour (toggle focus mode,
 * stopping propagation so the click never drags the node or reaches the canvas) for every node
 * type — agent, terminal, browser, music, note, task, plan, context, critic, gate, team, skills.
 * Placed just before each header's close button.
 */
export const CanvasNodeFocusAction = memo(function CanvasNodeFocusAction({
  onFocus,
  className = "canvas-persona-action canvas-persona-action--focus",
  iconSize = 11,
}: CanvasNodeFocusActionProps) {
  return (
    <button
      type="button"
      className={className}
      aria-label="Focus"
      title="Focus (double-click header also works · Esc to exit)"
      onClick={(e) => {
        e.stopPropagation();
        onFocus();
      }}
    >
      <Scan size={iconSize} aria-hidden />
    </button>
  );
});
