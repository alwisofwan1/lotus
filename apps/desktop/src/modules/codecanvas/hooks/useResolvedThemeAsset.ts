"use client";
import { useEffect, useState } from "react";
import { isLocalAssetRef, toDataUri } from "../services/theme/canvas-theme-asset";
import { readCanvasThemeAsset, canvasThemeMediaUrl } from "@/lib/tauri-api";

/**
 * Resolve a theme media ref to a display-ready URL (ADR-0023). A LOCAL ref (relative to
 * the theme folder) resolves two ways: "url" → asset-protocol URL (video streams via Range
 * requests); "data" → base64 data: URI (images + posters). Remote/data refs pass through.
 * The result is tagged with its ref so a stale resolution is ignored after the ref changes.
 *
 * Originally extracted from CanvasPaperMedia so nodes could draw the wallpaper as a frosted
 * per-node backdrop. That consumer is gone (canvas terminals paint an opaque floor, so a layer
 * beneath them was unreachable); CanvasPaperMedia — the full-bleed canvas wallpaper — is the
 * remaining caller, and the extraction stays because the stale-ref tagging is worth its own unit.
 */
export function useResolvedThemeAsset(
  themeId: string,
  ref: string | undefined,
  prefer: "url" | "data",
): string | undefined {
  const [entry, setEntry] = useState<{ ref: string; out: string } | null>(null);
  useEffect(() => {
    if (!ref || !isLocalAssetRef(ref)) return; // ready refs need no resolution
    let live = true;
    const task =
      prefer === "url"
        ? canvasThemeMediaUrl(themeId, ref)
        : readCanvasThemeAsset(themeId, ref).then((a) => (a ? toDataUri(a.mime, a.base64) : null));
    void task.then((out) => { if (live && out) setEntry({ ref, out }); });
    return () => { live = false; };
  }, [themeId, ref, prefer]);

  if (!ref) return undefined;
  if (!isLocalAssetRef(ref)) return ref; // remote/data: use as-is
  return entry?.ref === ref ? entry.out : undefined; // local: only the matching resolution
}
