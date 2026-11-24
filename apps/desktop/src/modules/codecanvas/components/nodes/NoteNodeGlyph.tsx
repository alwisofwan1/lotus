"use client";
import { memo } from "react";
import { Sprout } from "lucide-react";

interface Props {
  /** Same derived title as the header tooltip and the body's serif title. */
  title: string;
  done: number;
  total: number;
}

/**
 * The zoomed-out note (ADR-0046, mockup 05): one paper card with the sprout, the serif title and
 * checklist progress — the note stays findable by NAME from far away, where the old monogram block
 * ("DS") only said "a note is here".
 *
 * Keeps `canvas-node-glyph`: NOTE_DRAG_HANDLE includes it, so the card is still draggable.
 * The type is large on purpose — this renders at 12–50% zoom.
 */
export const NoteNodeGlyph = memo(function NoteNodeGlyph({ title, done, total }: Props) {
  return (
    <div className="canvas-node-glyph canvas-note-glyph" role="img" aria-label={`${title} — note`} title={title}>
      <span className="cng-chip" aria-hidden>
        <Sprout size={40} />
      </span>
      <span className="cng-title">{title}</span>
      {total > 0 && <span className="cng-progress">{done} of {total} done</span>}
    </div>
  );
});
