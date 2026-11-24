"use client";
import { memo, useCallback, useEffect, useRef } from "react";
import { ExternalLink } from "lucide-react";
import type { MusicTrack } from "../../services/music/music-track";
import { registerVideoSlot } from "../../services/music/music-video-host";

interface Props {
  track: MusicTrack;
  playing: boolean;
  current: number;
  duration: number;
  playbackFailure?: {
    badge: string;
    message: string;
    showOpenExternally: boolean;
  } | null;
  onSeek: (seconds: number) => void;
  onOpenExternal?: () => void;
}

/**
 * Full-width artwork with the seek hairline fused to its bottom edge and
 * typography-led title/author below. The pulse dot next to the author is the
 * player's only "playing" signal (mockup v2 — no decorative equalizer).
 *
 * The video itself is NOT rendered here. `.canvas-music-media-slot` is an empty box
 * offered to the session's single video host (`music-video-host.ts`), which parks
 * its iframe over that rect. The node therefore shows live video without owning the
 * element — the element belongs to no surface, so unmounting this node (project
 * switch, LOD collapse) moves the video to the mini player instead of killing it.
 * The thumbnail behind the slot is the poster for when nothing is loaded.
 */
export const MusicNowPlaying = memo(function MusicNowPlaying({ track, playing, current, duration, playbackFailure, onSeek, onOpenExternal }: Props) {
  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const slotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    // Clip to the ReactFlow pane so a node dragged past the canvas edge cannot bleed
    // video over the app chrome. Found by class, not by importing xyflow.
    const pane = slot.closest<HTMLElement>(".react-flow");
    return registerVideoSlot(slot, {
      kind: "node",
      clipTo: pane,
      borderRadius: typeof window !== "undefined" ? getComputedStyle(slot).borderRadius : undefined,
    });
  }, []);

  const seekFromPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(Math.round(ratio * duration));
  }, [duration, onSeek]);

  return (
    <div className="canvas-music-now">
      <div className="canvas-music-media">
        {track.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote YouTube thumbnail in a static export; next/image would need a loader
          <img src={track.thumbnailUrl} alt="" aria-hidden draggable={false} />
        ) : null}
        {/* The video host's landing rect. Stops short of the seek strip so the rail
            below stays clickable — a body-level host would otherwise swallow it. */}
        <div className="canvas-music-media-slot" ref={slotRef} aria-hidden />
        {playbackFailure ? (
          <div className="canvas-music-playback-fallback">
            <span className="canvas-music-playback-badge">{playbackFailure.badge}</span>
            <p>{playbackFailure.message}</p>
            {playbackFailure.showOpenExternally && onOpenExternal ? (
              <button type="button" onClick={onOpenExternal}>
                <ExternalLink aria-hidden />
                Open on YouTube
              </button>
            ) : null}
          </div>
        ) : null}
        <div
          className="canvas-music-seek"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          tabIndex={0}
          onPointerDown={seekFromPointer}
          onKeyDown={(e) => {
            if (duration <= 0) return;
            if (e.key === "ArrowRight") onSeek(Math.min(duration, current + 10));
            if (e.key === "ArrowLeft") onSeek(Math.max(0, current - 10));
          }}
        >
          <div className="canvas-music-seek-rail">
            <div className="canvas-music-seek-fill" style={{ width: `${pct}%` }} />
            <div className="canvas-music-seek-knob" style={{ left: `${pct}%` }} />
          </div>
        </div>
      </div>
      <div className="canvas-music-meta">
        <h3 title={track.title}>{track.title}</h3>
        <p>
          <span className={`canvas-music-dot${playing ? " canvas-music-dot--playing" : ""}`} aria-hidden />
          <span className="canvas-music-artist">{track.author}</span>
        </p>
      </div>
    </div>
  );
});
