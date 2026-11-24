"use client";
import { memo, useCallback, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import type { MusicTrack } from "../../services/music/music-track";
import { formatPlaybackTime } from "./MusicTransport";

interface Props {
  tracks: readonly MusicTrack[];
  activeTrackId?: string;
  playing: boolean;
  /** Tracks that refused to embed this session — dimmed, badged, skipped on auto-advance. */
  erroredIds: ReadonlySet<string>;
  onSelect: (trackId: string) => void;
  onDelete: (trackId: string) => void;
  onRename: (trackId: string, title: string) => void;
  onMove: (trackId: string, toIndex: number) => void;
}

/**
 * Index-mono rows, no thumbnails (mockup v2). Click plays; hover swaps the
 * duration for a minimal remove affordance and the index for a drag grip
 * (HTML5 DnD reorder); the playing row's index becomes the pulse dot. Rename
 * remains available by double-clicking the title.
 */
export const MusicTracklist = memo(function MusicTracklist({ tracks, activeTrackId, playing, erroredIds, onSelect, onDelete, onRename, onMove }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const dragIdRef = useRef<string | null>(null);

  const commitRename = useCallback(() => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  }, [editingId, draft, onRename]);

  return (
    <div className="canvas-music-tracklist nowheel">
      <div className="canvas-music-tl-head">
        <span className="canvas-music-tl-label">Tracklist</span>
        <span className="canvas-music-tl-count">{tracks.length}</span>
      </div>
      <div className="canvas-music-tl-rows" role="list">
        {tracks.map((track, index) => {
          const active = track.id === activeTrackId;
          const errored = erroredIds.has(track.id);
          const editing = editingId === track.id;
          return (
            <div
              key={track.id}
              role="listitem"
              className={`canvas-music-row${active ? " canvas-music-row--active" : ""}${errored ? " canvas-music-row--error" : ""}`}
              draggable={!editing}
              onDragStart={(e) => {
                dragIdRef.current = track.id;
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdRef.current && dragIdRef.current !== track.id) onMove(dragIdRef.current, index);
                dragIdRef.current = null;
              }}
              onClick={(e) => {
                if (editing || (e.target as HTMLElement).closest("button, input")) return;
                onSelect(track.id);
              }}
              onKeyDown={(e) => {
                if (!editing && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                  e.preventDefault();
                  onSelect(track.id);
                }
              }}
              tabIndex={0}
            >
              <span className="canvas-music-row-idx">
                <span className="canvas-music-row-n">{String(index + 1).padStart(2, "0")}</span>
                <GripVertical className="canvas-music-row-grip" aria-hidden />
                {active && playing ? <span className="canvas-music-dot canvas-music-dot--playing" aria-label="Playing" /> : null}
              </span>
              {editing ? (
                <input
                  className="canvas-music-row-edit"
                  value={draft}
                  autoFocus
                  aria-label="Rename track"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <p className="canvas-music-row-title" title={`${track.title} — ${track.author}`}
                  onDoubleClick={() => { setEditingId(track.id); setDraft(track.title); }}>
                  {track.title}
                </p>
              )}
              {errored ? <span className="canvas-music-row-badge">NO EMBED</span> : (
                <span className="canvas-music-row-dur">{track.durationSec ? formatPlaybackTime(track.durationSec) : "–:––"}</span>
              )}
              <button
                className="canvas-music-row-remove"
                aria-label="Delete track"
                title="Remove from tracklist"
                onClick={() => onDelete(track.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
