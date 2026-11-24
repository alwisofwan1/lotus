"use client";
import { memo } from "react";
import { X, Image as ImageIcon } from "lucide-react";
import { useCanvasAttachments } from "../../hooks/useCanvasAttachments";
import { canvasAttachmentStore } from "../../services/canvas-attachment-store";
import type { CanvasImageRef } from "../../services/canvas-intake";

function refLabel(ref: CanvasImageRef): string {
  return ref.kind === "path" ? (ref.path.split(/[\\/]/).pop() || ref.path) : ref.name;
}

/** Compact, self-contained row of a node's held image attachments (drop/paste). */
export const CanvasAttachmentStrip = memo(function CanvasAttachmentStrip({ nodeId }: { nodeId: string }) {
  const refs = useCanvasAttachments(nodeId);
  if (refs.length === 0) return null;
  return (
    <div className="canvas-attachment-strip nodrag">
      {refs.map((ref, index) => (
        <span key={`${refLabel(ref)}-${index}`} className="canvas-attachment-chip" title={refLabel(ref)}>
          <ImageIcon size={10} aria-hidden />
          <span className="canvas-attachment-name">{refLabel(ref)}</span>
          <button
            className="canvas-attachment-remove"
            aria-label={`Remove ${refLabel(ref)}`}
            onClick={() => canvasAttachmentStore.removeAt(nodeId, index)}
          >
            <X size={9} aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
});
