"use client";
import { memo, useEffect, useRef, type CSSProperties } from "react";
import type { CanvasPaperMedia as PaperMedia } from "../types/canvas-theme";
import { useCanvasVideoPolicy } from "../hooks/useCanvasVideoPolicy";
import { useCanvasTheme } from "../hooks/useCanvasTheme";
import { useResolvedThemeAsset } from "../hooks/useResolvedThemeAsset";

// Phase 2 + Layer 5/5b (ADR-0023): renders a theme's paper media (image or looping
// video) as a full-bleed backdrop behind the graph. Video respects the smart-pause
// policy. Media-ref resolution lives in useResolvedThemeAsset: "url" for video (streams via
// Range), "data" URI for images + posters. (It used to be shared with a frosted per-node backdrop;
// that layer is gone — canvas terminals paint an opaque floor now, so nothing sat behind them.)

export const CanvasPaperMedia = memo(function CanvasPaperMedia({ media }: { media: PaperMedia }) {
  const { themeId } = useCanvasTheme();
  const shouldPlay = useCanvasVideoPolicy();
  const videoRef = useRef<HTMLVideoElement>(null);

  // Video streams via the asset protocol; images + posters use base64.
  const src = useResolvedThemeAsset(themeId, media.src, media.kind === "video" ? "url" : "data");
  const poster = useResolvedThemeAsset(themeId, media.poster, "data");

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (shouldPlay && src) void v.play().catch(() => {});
    else v.pause();
  }, [shouldPlay, src]);

  const style: CSSProperties = { objectFit: media.fit };

  if (media.kind === "video") {
    // Render with the poster immediately; swap in src once a local ref resolves.
    return (
      <video
        ref={videoRef}
        className="canvas-paper-media"
        style={style}
        src={src}
        poster={poster}
        muted
        loop
        playsInline
        preload="metadata"
        aria-hidden
      />
    );
  }
  if (!src) return null; // local image still loading
  // next/image doesn't apply: Tauri static export, local/data-URI sources, no loader.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="canvas-paper-media" style={style} src={src} alt="" aria-hidden />;
});
