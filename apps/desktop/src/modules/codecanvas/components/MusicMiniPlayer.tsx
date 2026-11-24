"use client";
import { memo, useEffect, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import {
  next,
  prev,
  stopPlayback,
  togglePlay,
  useMusicEngine,
} from "../services/music/music-engine";
import {
  registerVideoSlot,
  useVideoSlotOwner,
  wakeVideoHost,
} from "../services/music/music-video-host";
import { useMusicTracklist } from "../services/music/music-tracklist-store";
import { formatPlaybackTime } from "./nodes/MusicTransport";

interface Props {
  /**
   * Distance from the window's right edge. The shell passes a larger value on
   * platforms whose window controls live top-right (Windows/Linux); on macOS the
   * traffic lights are top-left, so the strip can sit flush in the corner.
   */
  rightOffsetPx?: number;
}

/**
 * The music player's fallback home (plan
 * `plans/canvas-music-persistent-playback/PLAN.md` Tahap 1+2, then quieted twice
 * after real use: a permanent picture-in-picture over the canvas read as clutter,
 * and even a bottom-right pill still sat in the work).
 *
 * It now lives in the top-right chrome band — the one strip of the window that is
 * never work surface — as a ~22px line: mark, title, play/pause. Hover or focus
 * drops a small panel with the video, prev/next, time.
 *
 * Rendered by `AppShell` — which lives in the root layout — so it is available on
 * every route and outlives every project switch. It owns no player element: like
 * the canvas node, it only offers a slot, and the session's single video host parks
 * its iframe there. That is why this component may unmount freely the moment a
 * music node claims the video (higher slot priority): nothing audible lives here.
 *
 * At rest it offers NO slot, so the video host parks off-screen and only the audio
 * remains (the same trick `probeYouTubeIframePlayback` relies on). Deliberate trade:
 * while collapsed the YouTube player is not visible, which the embed terms do not
 * love; the alternative was a video that never stops competing for attention.
 */
export const MusicMiniPlayer = memo(function MusicMiniPlayer({ rightOffsetPx = 14 }: Props) {
  const engine = useMusicEngine();
  const tracks = useMusicTracklist();
  const owner = useVideoSlotOwner();
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  // A music node is showing the video in its own artwork — stay out of the way.
  const visible = engine.loaded && owner !== "node";
  const expanded = hovered || focused;

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot || !visible || !expanded) return;
    return registerVideoSlot(slot, {
      kind: "dock",
      borderRadius: typeof window !== "undefined" ? getComputedStyle(slot).borderRadius : undefined,
    });
  }, [visible, expanded]);

  // Expanding/collapsing changes geometry that no input event describes, and the
  // follow loop may be parked — tell it to look again.
  useEffect(() => {
    wakeVideoHost();
  }, [expanded, visible]);

  if (!visible) return null;

  const track = tracks.find((candidate) => candidate.id === engine.trackId) ?? null;
  const duration = engine.duration || track?.durationSec || 0;
  const pct = duration > 0 ? Math.min(100, (engine.currentTime / duration) * 100) : 0;
  const title = track?.title ?? "Music";

  return (
    <aside
      className="lotus-mini-player"
      data-expanded={expanded ? "true" : "false"}
      data-playing={engine.playing ? "true" : "false"}
      style={{ right: `${rightOffsetPx}px` }}
      aria-label="Music mini player"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div className="lotus-mini-player-strip">
        <span className="lotus-mini-player-glyph" aria-hidden>♪</span>
        <p className="lotus-mini-player-title" title={track ? `${track.title} — ${track.author}` : title}>
          {title}
        </p>
        <button
          type="button"
          className="lotus-mini-player-play"
          onClick={togglePlay}
          aria-label={engine.playing ? "Pause" : "Play"}
          aria-pressed={engine.playing}
          disabled={Boolean(engine.environmentFailure)}
          title={engine.environmentFailure?.message ?? (engine.playing ? "Pause" : "Play")}
        >
          {engine.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </button>
        <button
          type="button"
          className="lotus-mini-player-close"
          onClick={stopPlayback}
          aria-label="Close player"
          title="Close player (keeps your place in the track)"
        >
          <X aria-hidden />
        </button>
      </div>

      <div className="lotus-mini-player-panel">
        {/* Landing rect for the video host — deliberately empty, and only registered
            while expanded so the resting strip carries no video at all. */}
        <div className="lotus-mini-player-media" ref={slotRef} aria-hidden />
        <div className="lotus-mini-player-controls">
          <button
            type="button"
            className="lotus-mini-player-btn"
            onClick={prev}
            aria-label="Previous track"
            title="Previous track"
          >
            <SkipBack aria-hidden />
          </button>
          <button
            type="button"
            className="lotus-mini-player-btn"
            onClick={next}
            aria-label="Next track"
            title="Next track"
          >
            <SkipForward aria-hidden />
          </button>
          <span className="lotus-mini-player-time">
            {formatPlaybackTime(engine.currentTime)}
            <span aria-hidden> / </span>
            {formatPlaybackTime(duration)}
          </span>
        </div>
      </div>

      <div className="lotus-mini-player-progress" aria-hidden>
        <div className="lotus-mini-player-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </aside>
  );
});
