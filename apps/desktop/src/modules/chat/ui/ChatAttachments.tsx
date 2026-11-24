"use client";

import { ArrowDown, FileText, Plus, X } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { formatBytes, isCopy, type DraftAttachment } from "../domain/attachments";
import type { Attachment } from "../domain/thread-event";
import { usePreview } from "./attachment-preview";
import { ChatImageViewer } from "./ChatImageViewer";

// Mockup: mockups/lotus-chat.fig, page "04e Attachments", board B (#279). Images as 40px
// thumbnails, other files as a pill with their name; the same chips in the composer and the sent message.

interface AttachmentChipProps {
  attachment: Attachment;
  problem?: string | null;
  /** On its way to the chat's machine (ADR-0069). */
  pending?: string | null;
  /** How far that copy is, 0–100; drawn as a bar along the chip's foot. */
  progress?: number | null;
  onRemove?: () => void;
  /** An image opens the viewer; with it the thumb is a button, and hovering it peeks (composer). */
  onOpen?: () => void;
}

export function AttachmentChip({ attachment, problem = null, pending = null, progress = null, onRemove, onOpen }: AttachmentChipProps) {
  const image = attachment.kind === "image" && !problem;
  const preview = usePreview(attachment.path, image);
  // A copy on the chat's machine says so; the user's own file there does not.
  const copy = isCopy(attachment);
  const there = attachment.remote !== undefined && !copy;
  const note = problem ?? pending;
  return (
    <li
      className="chat-attachment"
      data-kind={image ? "image" : "file"}
      data-problem={problem ? true : undefined}
      data-pending={pending ? true : undefined}
      aria-busy={pending ? true : undefined}
      data-progress={pending && progress !== null ? true : undefined}
      style={pending && progress !== null ? ({ "--chat-attachment-progress": `${progress}%` } as CSSProperties) : undefined}
      title={note ? `${attachment.name} — ${note}` : copy ? `${attachment.path} — sent as a copy` : attachment.path}
    >
      {image && onOpen ? (
        <>
          <button type="button" className="chat-attachment-thumb" aria-label={`Open ${attachment.name}`} onClick={onOpen}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL, nothing for next/image to optimise */}
            {preview && <img src={preview} alt="" decoding="async" />}
          </button>
          {/* Shown by CSS after a hover pause, or on focus; mockups/chat-image-preview.html §1 A. */}
          <span className="chat-attachment-peek" aria-hidden>
            {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
            {preview && <img src={preview} alt="" decoding="async" />}
            <span className="chat-attachment-peek-cap">
              <span className="chat-attachment-peek-name">{attachment.name}</span>
              <span>{formatBytes(attachment.sizeBytes)}</span>
            </span>
          </span>
        </>
      ) : image ? (
        <span className="chat-attachment-thumb">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL, nothing for next/image to optimise */}
          {preview && <img src={preview} alt={attachment.name} decoding="async" />}
        </span>
      ) : (
        <>
          <FileText className="chat-attachment-icon" size={14} aria-hidden />
          <span className="chat-attachment-text">
            <span className="chat-attachment-name">{attachment.name}</span>
            <span className="chat-attachment-meta">{note ?? (copy ? `Copy · ${formatBytes(attachment.sizeBytes)}` : there ? "On the machine" : formatBytes(attachment.sizeBytes))}</span>
          </span>
        </>
      )}
      {onRemove && (
        <button type="button" className="chat-attachment-remove" aria-label={`Remove ${attachment.name}`} onClick={onRemove}>
          <X size={10} strokeWidth={2.6} aria-hidden />
        </button>
      )}
    </li>
  );
}

/** What is attached and not sent yet, each with ×. Nothing when empty. */
export function AttachmentDrafts({ drafts, onRemove }: { drafts: readonly DraftAttachment[]; onRemove: (id: string) => void }) {
  const images = drafts.filter((d) => d.attachment.kind === "image" && !d.problem).map((d) => d.attachment);
  const [viewing, setViewing] = useState<number | null>(null);
  if (drafts.length === 0) return null;
  return (
    <ul className="chat-attachments chat-composer-attachments" aria-label="Attached">
      {drafts.map((d) => {
        const at = images.indexOf(d.attachment);
        return (
          <AttachmentChip
            key={d.id}
            attachment={d.attachment}
            problem={d.problem}
            pending={d.pending ?? null}
            progress={d.progress ?? null}
            onRemove={() => onRemove(d.id)}
            onOpen={at < 0 ? undefined : () => setViewing(at)}
          />
        );
      })}
      {viewing !== null && viewing < images.length && (
        <ChatImageViewer images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      )}
    </ul>
  );
}

/** The most frames a sent message shows; the last one says how many more there are. */
const GALLERY_FRAMES = 4;

/**
 * A sent message's images, above its bubble (mockups/chat-image-preview.html §2). Each count has
 * fixed frame sizes, so the virtualized timeline measures the row once and never again.
 */
export function ImageGallery({ images }: { images: readonly Attachment[] }) {
  const [viewing, setViewing] = useState<number | null>(null);
  if (images.length === 0) return null;
  const shown = images.slice(0, GALLERY_FRAMES);
  return (
    <div className="chat-gallery" data-count={shown.length} role="group" aria-label={`${images.length} ${images.length === 1 ? "image" : "images"}`}>
      {shown.map((image, i) => (
        <GalleryFrame
          key={image.path}
          image={image}
          more={i === GALLERY_FRAMES - 1 ? images.length - GALLERY_FRAMES : 0}
          onOpen={() => setViewing(i)}
        />
      ))}
      {viewing !== null && <ChatImageViewer images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function GalleryFrame({ image, more, onOpen }: { image: Attachment; more: number; onOpen: () => void }) {
  const url = usePreview(image.path, true);
  return (
    <button type="button" className="chat-gallery-frame" aria-label={more > 0 ? `Open ${image.name} and ${more} more` : `Open ${image.name}`} title={image.name} onClick={onOpen}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
      {url && <img src={url} alt="" decoding="async" />}
      {more > 0 && <span className="chat-gallery-more">+{more}</span>}
    </button>
  );
}

/** The + that opens the file picker. `refuse` disables it and says why. */
export function AttachButton({ onPick, disabled = false, refuse = null }: { onPick: () => void; disabled?: boolean; refuse?: string | null }) {
  return (
    <button
      type="button"
      className="chat-composer-attach"
      aria-label="Attach files"
      title={refuse ?? "Attach files — or paste, or drop them here"}
      disabled={disabled || refuse !== null}
      onClick={onPick}
    >
      <Plus size={15} aria-hidden />
    </button>
  );
}

/** Over the whole chat panel while files are dragged onto it: all of it takes the drop. Without a
 *  panel (no `.chat-main` around the box) it covers just the box. */
/** Shown on the composer while a file is dragged anywhere over the chat; the drop lands there. */
export function AttachmentDrop() {
  return (
    <div className="chat-composer-drop" aria-hidden>
      <span className="chat-composer-drop-title">
        <ArrowDown size={14} strokeWidth={2} aria-hidden />
        Drop to attach
      </span>
      <span className="chat-composer-drop-hint">Images as pictures · files by path</span>
    </div>
  );
}
