"use client";
/* eslint-disable @next/next/no-img-element */
import { memo } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { useNoteAssetSrc } from "../../hooks/useNoteAssetSrc";

interface Props {
  coverUri: string;
  /** Absent when the note cannot store a new image (no project), so only Remove shows. */
  onChange?: () => void;
  onRemove: () => void;
}

/**
 * The note's optional cover (ADR-0046, mockup 01): a 150px photo across the top of the page.
 * Change / Remove appear on hover, like the inline image controls.
 */
export const NoteNodeCover = memo(function NoteNodeCover({ coverUri, onChange, onRemove }: Props) {
  const src = useNoteAssetSrc(coverUri);
  return (
    <div className="canvas-note-cover">
      {src && <img src={src} alt="" draggable={false} />}
      <div className="canvas-note-cover-controls nodrag">
        {onChange && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onChange();
            }}
          >
            <ImageUp size={12} aria-hidden />
            Change
          </button>
        )}
        <button
          type="button"
          aria-label="Remove cover"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 size={12} aria-hidden />
        </button>
      </div>
    </div>
  );
});
