"use client";
import { Play } from "lucide-react";

export interface CanvasDormantAgentCardProps {
  /** The conversation's own title, so the card says what it is rather than "a session". */
  title?: string | null;
  /** The last thing the agent said, read from the runner's own transcript. */
  preview?: string | null;
  /** Runner + turns + age, the same one line the session lists use. */
  meta?: string | null;
  loadingPreview?: boolean;
  onResume: () => void;
}

/**
 * An agent node that has a conversation but no process (`plans/codecanvas-session-widget/`,
 * Slice 04).
 *
 * It is what a node looks like the moment a board is reopened: the work is remembered, nothing is
 * running, and the CLI starts when — and only when — someone asks for it. That deferral is the
 * whole point (see `services/session-dormancy.ts` for the numbers behind it), so the card must make
 * "nothing is running" obvious rather than look like an agent that is merely quiet.
 */
export function CanvasDormantAgentCard({
  title,
  preview,
  meta,
  loadingPreview = false,
  onResume,
}: CanvasDormantAgentCardProps) {
  return (
    <div className="canvas-dormant-card" data-testid="dormant-agent-card">
      <p className="canvas-dormant-state">Not running</p>
      {title ? <p className="canvas-dormant-title">{title}</p> : null}
      <p className="canvas-dormant-preview" data-loading={loadingPreview ? "true" : undefined}>
        {loadingPreview
          ? "Reading the last conversation…"
          : preview?.trim() || "The previous conversation is saved."}
      </p>
      {meta ? <p className="canvas-dormant-meta">{meta}</p> : null}
      <button type="button" className="canvas-dormant-resume" onClick={onResume}>
        <Play size={11} aria-hidden /> Resume
      </button>
    </div>
  );
}
