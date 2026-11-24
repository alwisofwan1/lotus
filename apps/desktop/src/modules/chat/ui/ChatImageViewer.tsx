"use client";

import { ChevronLeft, ChevronRight, Copy, FolderOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

import { formatBytes } from "../domain/attachments";
import type { Attachment } from "../domain/thread-event";
import { readChatFileBytes, revealChatFile } from "../runtime/chat-runtime-client";
import { cachedPreview, usePreview } from "./attachment-preview";

// Mockup: mockups/chat-image-preview.html §3; plan: plans/chat-image-preview/PLAN.md slice 1. One
// viewer for the composer's drafts and a sent message's images. The image alone, fitted to the window:
// no zoom bar, nothing to scroll.

interface ChatImageViewerProps {
  images: readonly Attachment[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

const MISSING = "It is no longer on disk, or cannot be read.";

export function ChatImageViewer({ images, index, onIndex, onClose }: ChatImageViewerProps) {
  const image = images[index];
  const rootRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);
  // The thumbs already fetched this data URL, so the full view usually draws at once. `false` = unreadable.
  const [src, setSrc] = useState<{ path: string; url: string | false } | null>(null);
  const path = image?.path;
  useEffect(() => {
    if (!path) return;
    let live = true;
    cachedPreview(path).then(
      (url) => live && setSrc({ path, url }),
      () => live && setSrc({ path, url: false }),
    );
    return () => {
      live = false;
    };
  }, [path]);
  const many = images.length > 1;
  const step = (by: number) => onIndex((index + by + images.length) % images.length);

  // The cursor goes back where it came from (the thumb), so the composer keeps its place.
  useEffect(() => {
    const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus();
    return () => from?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 1400);
    return () => clearTimeout(timer);
  }, [note]);

  if (!image) return null;
  const url = src?.path === image.path ? src.url : null;
  const slash = image.path.lastIndexOf("/");

  const copy = async () => {
    try {
      // WKWebView's ClipboardItem path is unproven; the native plugin reads a PNG straight from disk.
      if (isTauri() && /\.png$/i.test(image.path)) {
        try {
          await tauriInvoke("plugin:clipboard-manager|write_image", { image: image.path });
          setNote("Copied");
          return;
        } catch {
          // An older binary without the `image-png` feature: fall through to the browser path.
        }
      }
      // A promise inside the item keeps WebKit's user gesture across the read and the re-encode.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": readChatFileBytes(image.path).then(asPng) })]);
      setNote("Copied");
    } catch {
      setNote("Could not copy the image");
    }
  };

  return createPortal(
    <div
      ref={rootRef}
      className="chat-viewer"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`${image.name}${many ? `, ${index + 1} of ${images.length}` : ""}`}
      onKeyDown={(event) => {
        const root = event.currentTarget;
        if (event.key === "Tab") return trapTab(event, root);
        const onButton = event.target instanceof HTMLButtonElement;
        if (event.key === "Escape" || (event.key === " " && !onButton)) onClose();
        else if (event.key === "ArrowRight" && many) step(1);
        else if (event.key === "ArrowLeft" && many) step(-1);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="chat-viewer-head">
        <span className="chat-viewer-title" title={`${image.name} · ${formatBytes(image.sizeBytes)}`}>
          <span className="chat-viewer-name">{image.name}</span>
          {many && <span className="chat-viewer-meta">{`${index + 1} / ${images.length}`}</span>}
        </span>
        <span className="chat-viewer-actions">
          {note && (
            <span className="chat-viewer-note" role="status">
              {note}
            </span>
          )}
          <button type="button" className="chat-viewer-btn" aria-label="Copy" title="Copy image" onClick={() => void copy()}>
            <Copy size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="chat-viewer-btn"
            aria-label="Show in Finder"
            title="Show in Finder"
            onClick={() => void revealChatFile(image.path.slice(0, slash), image.path.slice(slash + 1)).catch(() => setNote(MISSING))}
          >
            <FolderOpen size={14} aria-hidden />
          </button>
          <button type="button" className="chat-viewer-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <X size={15} aria-hidden />
          </button>
        </span>
      </header>
      <div className="chat-viewer-stage">
        {url === false ? (
          <p className="chat-viewer-missing">{MISSING}</p>
        ) : (
          url && (
            // eslint-disable-next-line @next/next/no-img-element -- a local data URL
            <img key={image.path} className="chat-viewer-image" src={url} alt={image.name} draggable={false} />
          )
        )}
        {many && (
          <>
            <button type="button" className="chat-viewer-nav" data-side="prev" aria-label="Previous image" onClick={() => step(-1)}>
              <ChevronLeft size={18} aria-hidden />
            </button>
            <button type="button" className="chat-viewer-nav" data-side="next" aria-label="Next image" onClick={() => step(1)}>
              <ChevronRight size={18} aria-hidden />
            </button>
          </>
        )}
      </div>
      {many && (
        <div className="chat-viewer-strip">
          {images.map((other, i) => (
            <StripThumb key={other.path} image={other} current={i === index} onPick={() => onIndex(i)} />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

function StripThumb({ image, current, onPick }: { image: Attachment; current: boolean; onPick: () => void }) {
  const url = usePreview(image.path, true);
  return (
    <button type="button" className="chat-viewer-thumb" data-current={current || undefined} aria-label={image.name} aria-current={current || undefined} onClick={onPick}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
      {url && <img src={url} alt="" decoding="async" />}
    </button>
  );
}

/** aria-modal alone does not stop Tab: it would walk out into the app behind the backdrop. */
function trapTab(event: React.KeyboardEvent, root: HTMLElement) {
  const stops = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')];
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) return event.preventDefault();
  const at = document.activeElement;
  if (event.shiftKey && (at === first || at === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (at === last || at === root)) {
    event.preventDefault();
    first.focus();
  }
}

/** The clipboard takes PNG; a JPEG, GIF or WebP is drawn once and re-encoded. */
async function asPng(bytes: ArrayBuffer): Promise<Blob> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), "image/png"));
}
