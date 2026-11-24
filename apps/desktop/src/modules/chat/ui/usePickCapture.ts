"use client";

import { useRef } from "react";

import { captureEmbeddedBrowserPreview, type BrowserAnnotationPayload } from "@/lib/tauri/browser-preview";
import { savePastedAttachment } from "../runtime/chat-runtime-client";
import { cropOf, pickFrom, type Pick } from "../domain/preview";

interface PickTarget {
  /** The browser the pick came from, to screenshot the element. */
  slot: string;
  /** The thread (a UUID) whose attachment folder keeps the pictures. */
  saveTo: string;
}

/**
 * A browser pick made into a `Pick`, its pictures saved: Chat's Preview and Code's Browser pane alike.
 *
 * The overlay reports each pick more than once under one id. The first report adds it, with a
 * screenshot of the element; a later one brings the <img> pictures inside it, used only when the
 * screenshot could not be taken. Each id maps to whether its screenshot was taken.
 */
export function usePickCapture({ onPick, onNote }: { onPick: (target: PickTarget, pick: Pick) => void; onNote?: (target: PickTarget, note: string) => void }) {
  const shots = useRef(new Map<string, Promise<boolean>>());
  return async (target: PickTarget, payload: BrowserAnnotationPayload) => {
    const picked = pickFrom(payload);
    if (!picked) return;
    // Saved for the thread like a paste, so they go as pictures.
    const save = (images: Pick["images"]) =>
      Promise.all(
        images.map(async (a) => {
          const blob = await (await fetch(a.content)).blob();
          return savePastedAttachment(target.saveTo, new File([blob], a.name, { type: blob.type }));
        }),
      );
    const shot = shots.current.get(picked.id);
    if (shot) {
      if (picked.images.length === 0 || (await shot)) return;
      onPick(target, { ...picked, attachments: await save(picked.images) });
      return;
    }
    let taken: (ok: boolean) => void = () => {};
    shots.current.set(picked.id, new Promise((resolve) => (taken = resolve)));
    const note = payload.message?.trim();
    if (note) onNote?.(target, note);
    const crop = cropOf(payload);
    const image = crop ? await captureEmbeddedBrowserPreview(target.slot, crop).catch(() => null) : null;
    taken(image !== null);
    const images = image ? [{ name: `${picked.tag}.png`, content: image }] : picked.images;
    onPick(target, { ...picked, images, attachments: await save(images) });
  };
}
