"use client";

import { useEffect, useState } from "react";

import { attachmentPreview } from "../runtime/chat-runtime-client";

// `chat_attachment_preview` returns the whole file as a data URL (up to 5 MB, ~6.7 MB of base64),
// so the cache is bounded: the newest PREVIEW_CACHE_SIZE, most recently used first to stay.
export const PREVIEW_CACHE_SIZE = 24;
const previews = new Map<string, Promise<string>>();

export function cachedPreview(path: string, load: (path: string) => Promise<string> = attachmentPreview): Promise<string> {
  let pending = previews.get(path);
  if (pending) {
    previews.delete(path);
  } else {
    pending = load(path);
    pending.catch(() => previews.delete(path));
  }
  previews.set(path, pending);
  if (previews.size > PREVIEW_CACHE_SIZE) previews.delete(previews.keys().next().value!);
  return pending;
}

/** Test seam: what the cache holds, oldest first. */
export const previewCacheKeys = () => [...previews.keys()];

export function usePreview(path: string, image: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image) return;
    let live = true;
    cachedPreview(path).then((value) => live && setUrl(value), () => {});
    return () => {
      live = false;
    };
  }, [path, image]);
  return url;
}
