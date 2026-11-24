"use client";
import { useEffect, useState } from "react";
import { parseNoteAssetUri } from "../services/note-assets";
import { codecanvasReadNoteAsset } from "@/lib/tauri/codecanvas";

/**
 * A displayable `src` for a note image. `lotus-note-asset://<id>` is resolved to a data URL through
 * the note-asset store; any other src is passed through unchanged. Until the read lands — or if it
 * fails — the raw src is returned, so a broken asset shows as a broken image rather than nothing.
 */
export function useNoteAssetSrc(src: string | null | undefined): string | undefined {
  // Keyed by src, so a stale read for a previous src is never shown for the current one.
  const [resolved, setResolved] = useState<{ src: string; url: string } | null>(null);
  const assetId = src ? parseNoteAssetUri(src) : null;

  useEffect(() => {
    if (!src || !assetId) return;
    let live = true;
    void codecanvasReadNoteAsset(assetId)
      .then((res) => {
        if (live) setResolved({ src, url: `data:${res.asset.mime};base64,${res.base64}` });
      })
      .catch(() => {
        // Keep showing the raw src.
      });
    return () => {
      live = false;
    };
  }, [src, assetId]);

  if (!src) return undefined;
  return assetId && resolved?.src === src ? resolved.url : src;
}
