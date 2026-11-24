"use client";
import { memo } from "react";
import type { AgentNodeStatus } from "../../types/canvas";

export type CanvasGlyphTone = "idle" | "pending" | "active" | "done" | "error" | "neutral";

const AGENT_STATUS_TONE: Record<AgentNodeStatus, CanvasGlyphTone> = {
  idle: "idle",
  connecting: "pending",
  running: "active",
  // The glyph vocabulary has no attention tone, and adding one would mean a new colour token in
  // every Artisan theme for a mark a few pixels wide. `pending` is the honest nearest: not
  // progressing. The CARD is where `needs-you` is stated properly (AgentPersonaHeader).
  "needs-you": "pending",
  completed: "done",
  error: "error",
  stalled: "error",
};

/** Pick the glyph tone that mirrors an agent's live status colour. */
export function glyphToneForAgentStatus(status: AgentNodeStatus): CanvasGlyphTone {
  return AGENT_STATUS_TONE[status] ?? "neutral";
}

/** Two-letter monogram for the zoomed-out block (first+last word, or first two chars). */
export function glyphInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "··";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export interface CanvasNodeGlyphProps {
  label: string;
  tone: CanvasGlyphTone;
  detail?: string;
}

/** Zoomed-out representation of a Canvas Node — a solid status block (semantic LOD). */
export const CanvasNodeGlyph = memo(function CanvasNodeGlyph({ label, tone, detail }: CanvasNodeGlyphProps) {
  return (
    <div
      className={`canvas-node-glyph canvas-node-glyph--${tone}`}
      role="img"
      aria-label={detail ? `${label} — ${detail}` : label}
      title={label}
    >
      <span className="canvas-node-glyph-initials">{glyphInitials(label)}</span>
    </div>
  );
});
