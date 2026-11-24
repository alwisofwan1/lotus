"use client";
/* eslint-disable @next/next/no-img-element */
import { mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { AlignCenter, AlignLeft, AlignRight, RotateCcw, Trash2 } from "lucide-react";
import { useNoteAssetSrc } from "../../../hooks/useNoteAssetSrc";

const IMAGE_SIZES = { s: "38%", m: "64%", l: "100%" } as const;
type ImageSize = keyof typeof IMAGE_SIZES;

function NoteImageView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const { src, alt, align = "center", size = "m" } = node.attrs;
  const displaySrc = useNoteAssetSrc(src);

  const set = (patch: Record<string, string>) => updateAttributes(patch);
  const sizeButtons: ImageSize[] = ["s", "m", "l"];

  return (
    <NodeViewWrapper className={`canvas-note-image canvas-note-image--${align}`} contentEditable={false}>
      <div className="canvas-note-image-controls">
        <button type="button" aria-label="Align image left" data-active={align === "left" || undefined} onClick={() => set({ align: "left" })}>
          <AlignLeft size={13} aria-hidden />
        </button>
        <button type="button" aria-label="Align image center" data-active={align === "center" || undefined} onClick={() => set({ align: "center" })}>
          <AlignCenter size={13} aria-hidden />
        </button>
        <button type="button" aria-label="Align image right" data-active={align === "right" || undefined} onClick={() => set({ align: "right" })}>
          <AlignRight size={13} aria-hidden />
        </button>
        <span className="canvas-note-image-controls-divider" aria-hidden />
        {sizeButtons.map((s) => (
          <button
            key={s}
            type="button"
            aria-label={`Image size ${s.toUpperCase()}`}
            data-active={size === s || undefined}
            className="canvas-note-image-size"
            onClick={() => set({ size: s })}
          >
            {s.toUpperCase()}
          </button>
        ))}
        <span className="canvas-note-image-controls-divider" aria-hidden />
        <button type="button" aria-label="Reset image" onClick={() => set({ align: "center", size: "m" })}>
          <RotateCcw size={12} aria-hidden />
        </button>
        <button type="button" aria-label="Delete image" onClick={deleteNode}>
          <Trash2 size={12} aria-hidden />
        </button>
      </div>
      <img src={displaySrc} alt={alt ?? ""} style={{ width: IMAGE_SIZES[size as ImageSize] ?? IMAGE_SIZES.m }} />
    </NodeViewWrapper>
  );
}

/** Image node extended with alignment + size attributes, rendered through a React NodeView. */
export const NoteImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: "center",
        parseHTML: (el) => el.getAttribute("data-align") ?? "center",
        renderHTML: (a) => ({ "data-align": a.align }),
      },
      size: {
        default: "m",
        parseHTML: (el) => el.getAttribute("data-size") ?? "m",
        renderHTML: (a) => ({ "data-size": a.size }),
      },
    };
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(NoteImageView);
  },
});
