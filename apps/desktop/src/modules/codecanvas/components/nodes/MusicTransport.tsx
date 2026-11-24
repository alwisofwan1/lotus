"use client";
import { memo } from "react";
import { Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";

/** Clock-style playback time. Long mixes use H:MM:SS instead of unbounded minutes. */
export function formatPlaybackTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

interface Props {
  playing: boolean;
  current: number;
  duration: number;
  volume: number;
  disabled?: boolean;
  disabledReason?: string;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onVolume: (volume: number) => void;
}

/**
 * Minimal transport row: play (the only filled control) + ghost prev/next, a
 * stable volume rail, and mono time on the right. Seek lives on the artwork's
 * bottom edge (MusicNowPlaying), not here.
 */
export const MusicTransport = memo(function MusicTransport({ playing, current, duration, volume, disabled = false, disabledReason, onPlayPause, onPrev, onNext, onVolume }: Props) {
  const currentLabel = formatPlaybackTime(current);
  const durationLabel = formatPlaybackTime(duration);
  const VolumeIcon = volume <= 0 ? VolumeX : volume < 45 ? Volume1 : Volume2;

  return (
    <div className="canvas-music-transport">
      <button
        className="canvas-music-play"
        onClick={onPlayPause}
        aria-label={playing ? "Pause" : "Play"}
        aria-pressed={playing}
        disabled={disabled}
        title={disabled ? disabledReason : playing ? "Pause" : "Play"}
      >
        {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
      </button>
      <button className="canvas-music-tbtn" onClick={onPrev} aria-label="Previous track" title="Previous track"><SkipBack aria-hidden /></button>
      <button className="canvas-music-tbtn" onClick={onNext} aria-label="Next track" title="Next track"><SkipForward aria-hidden /></button>
      <div className="canvas-music-vol">
        <VolumeIcon aria-hidden />
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label="Volume"
          title={`Volume ${volume}%`}
          onChange={(e) => onVolume(Number(e.target.value))}
        />
      </div>
      <span className="canvas-music-time" aria-label={`Playback time ${currentLabel} of ${durationLabel}`} title={`${currentLabel} / ${durationLabel}`}>
        <b>{currentLabel}</b>
        <span className="canvas-music-time-sep" aria-hidden>/</span>
        <span>{durationLabel}</span>
      </span>
    </div>
  );
});
