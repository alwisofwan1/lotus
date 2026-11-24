"use client";
import { memo, useCallback, useEffect, useMemo } from "react";
import { Music } from "lucide-react";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import { musicResolveTrack } from "@/lib/tauri-api";
import { createMusicTrack, parseYoutubeVideoId } from "../../services/music/music-track";
import { classifyYouTubePlayerError } from "../../services/music/youtube-playback-health";
import {
  adoptLegacyNodeVolume,
  next,
  playTrack,
  prev,
  handleTrackRemoved,
  seek,
  selectTrack,
  setVolume,
  togglePlay,
  useMusicEngine,
} from "../../services/music/music-engine";
import {
  addTrack,
  moveTrack,
  removeTrack,
  renameTrack,
  useMusicTracklist,
} from "../../services/music/music-tracklist-store";
import type { MusicNodePatch } from "../../types/canvas";
import { MusicPasteBar } from "./MusicPasteBar";
import { MusicNowPlaying } from "./MusicNowPlaying";
import { MusicTransport } from "./MusicTransport";
import { MusicTracklist } from "./MusicTracklist";

interface Props {
  activeTrackId?: string;
  volume?: number;
  onPatch: (patch: MusicNodePatch) => void;
  onClose: () => void;
  onFocus?: () => void;
}

/**
 * The music player's canvas chrome: tracklist CRUD, paste bar, transport, artwork.
 *
 * It owns NO playback. Everything audible lives in the app-level music engine
 * (`services/music/music-engine.ts`), because a canvas node belongs to a
 * per-project snapshot and unmounts on every project switch — which used to kill
 * the audio with it. The live video sits in the app-level mini player; the node's
 * artwork is the track thumbnail (Tahap 2 hands the video back to the node).
 */
export const MusicNodeCard = memo(function MusicNodeCard({ activeTrackId, volume, onPatch, onClose, onFocus }: Props) {
  const tracks = useMusicTracklist();
  const engine = useMusicEngine();

  // The node's persisted `activeTrackId` is a restore hint, used only when the
  // engine has nothing selected yet (first canvas of the session).
  useEffect(() => {
    if (!engine.trackId && activeTrackId) selectTrack(activeTrackId);
  }, [engine.trackId, activeTrackId]);

  // v1 stored volume per node; the engine adopts it once, then owns it globally.
  useEffect(() => adoptLegacyNodeVolume(volume), [volume]);

  // Mirror the engine's selection back into the snapshot so reopening this canvas
  // lands on the same track.
  useEffect(() => {
    if (engine.trackId && engine.trackId !== activeTrackId) onPatch({ activeTrackId: engine.trackId });
  }, [engine.trackId, activeTrackId, onPatch]);

  const activeTrack = useMemo(
    () => tracks.find((track) => track.id === engine.trackId) ?? null,
    [tracks, engine.trackId],
  );

  const handleVolume = useCallback((nextVolume: number) => {
    setVolume(nextVolume);
    // Keep writing the legacy field so an older build still restores a sane volume.
    onPatch({ volume: nextVolume });
  }, [onPatch]);

  const handleOpenExternal = useCallback(() => {
    if (!activeTrack) return;
    window.open(activeTrack.url || `https://www.youtube.com/watch?v=${activeTrack.videoId}`, "_blank", "noopener,noreferrer");
  }, [activeTrack]);

  const handleResolve = useCallback(async (url: string) => {
    const videoId = parseYoutubeVideoId(url);
    if (!videoId) throw new Error("Not a valid YouTube link — try a watch / youtu.be / shorts URL.");
    const existing = tracks.find((track) => track.videoId === videoId);
    if (existing) {
      playTrack(existing.id); // paste = "play this", even when already saved
      return;
    }
    const meta = await musicResolveTrack(url);
    const track = addTrack(createMusicTrack({ url, videoId, meta }));
    playTrack(track.id);
  }, [tracks]);

  const handleDelete = useCallback((trackId: string) => {
    removeTrack(trackId);
    handleTrackRemoved(trackId);
  }, []);

  const activeTrackFailure = activeTrack && engine.erroredIds.has(activeTrack.id)
    ? classifyYouTubePlayerError(150)
    : engine.environmentFailure;
  const duration = engine.duration || activeTrack?.durationSec || 0;

  return (
    <div className="canvas-music">
      <div className="cth-root canvas-node-header canvas-music-header">
        <div className="cth-row1">
          <div className="cth-identity">
            <span className={`cth-dot ${engine.playing ? "cth-dot--running" : "cth-dot--idle"}`} aria-hidden />
            <span className="cth-glyph" aria-hidden>♪</span>
            <span className="cth-name">Music</span>
            <span className="cth-sep" aria-hidden>·</span>
            <span className="cth-loc">YouTube</span>
          </div>
          <div className="cth-actions" data-drag-handle="false">
            {onFocus && <CanvasNodeFocusAction onFocus={onFocus} className="cth-action cth-action--focus" />}
            <button className="cth-action cth-action--kill" onClick={onClose} aria-label="Close music player">
              ×
            </button>
          </div>
        </div>
      </div>
      <div className="canvas-music-body nodrag">
        <MusicPasteBar onSubmit={handleResolve} />
        {activeTrack ? (
          <>
            <MusicNowPlaying
              track={activeTrack}
              playing={engine.playing}
              current={engine.currentTime}
              duration={duration}
              playbackFailure={activeTrackFailure ? {
                badge: activeTrackFailure.badge,
                message: activeTrackFailure.message,
                showOpenExternally: true,
              } : null}
              onSeek={seek}
              onOpenExternal={handleOpenExternal}
            />
            <MusicTransport
              playing={engine.playing}
              current={engine.currentTime}
              duration={duration}
              volume={engine.volume}
              disabled={Boolean(activeTrackFailure)}
              disabledReason={activeTrackFailure?.message}
              onPlayPause={togglePlay}
              onPrev={prev}
              onNext={next}
              onVolume={handleVolume}
            />
          </>
        ) : (
          <div className="canvas-music-empty">
            <Music aria-hidden />
            <p>Paste a YouTube link to start a tracklist.<br />It is saved and available on every canvas.</p>
          </div>
        )}
        {tracks.length > 0 ? (
          <MusicTracklist
            tracks={tracks}
            activeTrackId={activeTrack?.id}
            playing={engine.playing}
            erroredIds={engine.erroredIds}
            onSelect={playTrack}
            onDelete={handleDelete}
            onRename={renameTrack}
            onMove={moveTrack}
          />
        ) : null}
      </div>
    </div>
  );
});
