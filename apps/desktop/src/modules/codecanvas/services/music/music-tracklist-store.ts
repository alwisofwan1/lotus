/**
 * Global music tracklist — ONE persisted playlist shared by every music node
 * across canvases/projects ("tracklist untuk ke depannya", plan §1). Module-level
 * useSyncExternalStore store backed by localStorage, mirroring
 * useCanvasBehaviorSettings: SSR-safe, hydrate-once, corrupt payloads fall back
 * to an empty list. Array order IS playlist order.
 */
import { useSyncExternalStore } from "react";
import type { MusicTrack } from "./music-track";

const STORAGE_KEY = "canvas-music-tracklist-v1";
const EMPTY: readonly MusicTrack[] = [];

let tracks: readonly MusicTrack[] = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function isTrack(value: unknown): value is MusicTrack {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.videoId === "string" &&
    typeof t.url === "string" &&
    typeof t.title === "string" &&
    typeof t.author === "string" &&
    typeof t.thumbnailUrl === "string" &&
    typeof t.addedAt === "number"
  );
}

function load(): readonly MusicTrack[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    // Drop malformed entries instead of poisoning the whole list.
    return parsed.filter(isTrack);
  } catch {
    return EMPTY;
  }
}

function hydrateOnce() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  tracks = load();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
  } catch {}
}

function setTracks(next: readonly MusicTrack[]) {
  tracks = next;
  persist();
  emit();
}

/** Current playlist, in play order. Hydrates from localStorage on first access. */
export function getTracks(): readonly MusicTrack[] {
  hydrateOnce();
  return tracks;
}

/** Subscribe to tracklist changes (React or plain callers). Returns the unsubscribe. */
export function subscribeTracklist(listener: () => void): () => void {
  hydrateOnce();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Add a track. Paste means "play this", so a repeat paste of the same video must
 * not duplicate: the existing track is returned untouched and the caller jumps
 * playback to it.
 */
export function addTrack(track: MusicTrack): MusicTrack {
  hydrateOnce();
  const existing = tracks.find((t) => t.videoId === track.videoId);
  if (existing) return existing;
  setTracks([...tracks, track]);
  return track;
}

/** Delete a track from the playlist. No-op when the id is unknown. */
export function removeTrack(id: string) {
  hydrateOnce();
  const next = tracks.filter((t) => t.id !== id);
  if (next.length !== tracks.length) setTracks(next);
}

/** Merge a partial update (e.g. durationSec backfill from the player) into a track. */
export function patchTrack(id: string, patch: Partial<Omit<MusicTrack, "id">>) {
  hydrateOnce();
  const index = tracks.findIndex((t) => t.id === id);
  if (index === -1) return;
  const next = [...tracks];
  next[index] = { ...next[index], ...patch };
  setTracks(next);
}

/** Rename a track (inline edit in the tracklist). Blank titles are ignored. */
export function renameTrack(id: string, title: string) {
  const trimmed = title.trim();
  if (!trimmed) return;
  patchTrack(id, { title: trimmed });
}

/** Move a track to a new playlist position (drag-reorder). The index is clamped. */
export function moveTrack(id: string, toIndex: number) {
  hydrateOnce();
  const from = tracks.findIndex((t) => t.id === id);
  if (from === -1) return;
  const next = [...tracks];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved);
  setTracks(next);
}

/**
 * The id after `currentId`, wrapping at the end (auto-advance + next button).
 * An unknown/deleted current id restarts from the head; empty list → null.
 */
export function nextTrackId(currentId: string): string | null {
  hydrateOnce();
  if (!tracks.length) return null;
  const index = tracks.findIndex((t) => t.id === currentId);
  if (index === -1) return tracks[0].id;
  return tracks[(index + 1) % tracks.length].id;
}

/** The id before `currentId`, wrapping at the head. Unknown id → head; empty → null. */
export function prevTrackId(currentId: string): string | null {
  hydrateOnce();
  if (!tracks.length) return null;
  const index = tracks.findIndex((t) => t.id === currentId);
  if (index === -1) return tracks[0].id;
  return tracks[(index - 1 + tracks.length) % tracks.length].id;
}

const getSnapshot = (): readonly MusicTrack[] => {
  hydrateOnce();
  return tracks;
};
const getServerSnapshot = (): readonly MusicTrack[] => EMPTY;

/** React binding — re-renders on any tracklist mutation. */
export function useMusicTracklist(): readonly MusicTrack[] {
  return useSyncExternalStore(subscribeTracklist, getSnapshot, getServerSnapshot);
}

/** Test-only: reset module state; `keepStorage` re-hydrates from localStorage on next read. */
export function resetMusicTracklistStoreForTests(opts?: { keepStorage?: boolean }) {
  tracks = EMPTY;
  hydrated = false;
  listeners.clear();
  if (!opts?.keepStorage) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
}
