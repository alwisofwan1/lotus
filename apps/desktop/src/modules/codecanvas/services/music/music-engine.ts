/**
 * App-level music engine — the single owner of playback for the whole session
 * (plan `plans/canvas-music-persistent-playback/PLAN.md` §2/§3).
 *
 * WHY a module singleton instead of node state: the v1 player lived inside the
 * canvas node, and a canvas node belongs to a per-project snapshot. Switching
 * project replaces the node array (`useCanvasNodes.loadSnapshot`), React unmounts
 * the node, the `<iframe>` leaves the DOM, and the audio dies. An `<iframe>`
 * cannot be re-parented without reloading, so the only correct shape is:
 * playback state + bridge live here, and the element itself lives somewhere that
 * never unmounts (Tahap 1: the app-level mini-player in `AppShell`).
 *
 * The engine never renders anything and never touches React — the element is
 * handed to it via `attachPlayerIframe`, and `src` is written imperatively so
 * play/pause can never trigger a reload (only a *track change* reloads).
 */
import { useSyncExternalStore } from "react";
import { isTauri, musicYoutubePlayerUrl } from "@/lib/tauri-api";
import { youtubeEmbedUrl, type MusicTrack } from "./music-track";
import {
  getTracks,
  nextTrackId,
  patchTrack,
  prevTrackId,
  subscribeTracklist,
} from "./music-tracklist-store";
import { ensureVideoHost, setVideoHostActive } from "./music-video-host";
import { publishNowPlaying } from "./music-now-playing";
import {
  classifyYouTubePlayerError,
  getCachedYouTubePlaybackProbeResult,
  probeYouTubeIframePlayback,
  resolveYouTubeEmbedOrigin,
  type YouTubePlaybackFailure,
} from "./youtube-playback-health";
import { createPlayerBridge, type PlayerBridge } from "./youtube-player-bridge";

const STORAGE_KEY = "canvas-music-playback-v1";
export const DEFAULT_MUSIC_VOLUME = 80;
/**
 * How far the music drops while a voice is talking over it. Low enough to hear the
 * agent clearly, high enough that the track is still there when it finishes.
 */
export const MUSIC_DUCK_RATIO = 0.22;
/** infoDelivery streams ~4×/s; publish the time at most every 500ms. */
const TIME_UPDATE_MS = 500;
/** Debounce for the localStorage write (volume slider drags, time ticks). */
const PERSIST_DEBOUNCE_MS = 700;
/** While playing, refresh the stored resume position at most this often. */
const PERSIST_POSITION_MS = 5_000;

export interface MusicEngineState {
  /** Selected track. May be set with `loaded: false` (restored from disk, no player yet). */
  trackId: string | null;
  /** True once a player exists for `trackId` — i.e. there is audio to protect. */
  loaded: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  /** 0..100, YouTube's own scale. Global: one engine, one volume. */
  volume: number;
  /** True while a voice (live agent, narration) holds the floor — see `duckMusic`. */
  ducked: boolean;
  /** Tracks that refused to embed this session — badged and skipped on advance. */
  erroredIds: ReadonlySet<string>;
  /** Build-level failure (embedding blocked here) — disables transport everywhere. */
  environmentFailure: YouTubePlaybackFailure | null;
}

interface PersistedPlayback {
  trackId: string | null;
  positionSec: number;
  volume: number;
}

const EMPTY_ERRORED: ReadonlySet<string> = new Set();

let state: MusicEngineState = {
  trackId: null,
  loaded: false,
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: DEFAULT_MUSIC_VOLUME,
  ducked: false,
  erroredIds: EMPTY_ERRORED,
  environmentFailure: null,
};

const listeners = new Set<() => void>();
let hydrated = false;
/** True when the restored record carried a volume — blocks the legacy node-volume adoption. */
let volumeFromStorage = false;
let iframe: HTMLIFrameElement | null = null;
let bridge: PlayerBridge | null = null;
/** The URL currently written to the iframe — re-applied when the element is replaced. */
let loadedUrl: string | null = null;
let pendingPlay = false;
/** Guards a slow wrapper-URL resolve against a newer load winning the race. */
let loadToken = 0;
let lastTimeUpdate = 0;
let lastPositionPersist = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let probeStarted = false;
/** Ref-counted: the agent voice and narration can both hold the floor at once. */
let duckHolders = 0;

function emit() {
  listeners.forEach((listener) => listener());
}

function setState(patch: Partial<MusicEngineState>) {
  state = { ...state, ...patch };
  publishOsNowPlaying();
  emit();
}

/** Mirror the engine into the OS Now Playing surface (Control Center, media keys). */
function publishOsNowPlaying() {
  const track = trackById(state.trackId);
  publishNowPlaying(
    state.loaded && track
      ? {
          title: track.title,
          artist: track.author,
          artworkUrl: track.thumbnailUrl,
          playing: state.playing,
          duration: state.duration || track.durationSec || 0,
          position: state.currentTime,
        }
      : null,
    { play: resumePlayback, pause, next, prev, seek },
  );
}

function readPersisted(): PersistedPlayback | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const trackId = typeof record.trackId === "string" ? record.trackId : null;
    const positionSec = typeof record.positionSec === "number" && Number.isFinite(record.positionSec)
      ? Math.max(0, Math.floor(record.positionSec))
      : 0;
    const volume = typeof record.volume === "number" && Number.isFinite(record.volume)
      ? Math.max(0, Math.min(100, Math.round(record.volume)))
      : null;
    return { trackId, positionSec, volume: volume ?? DEFAULT_MUSIC_VOLUME };
  } catch {
    return null;
  }
}

/**
 * Restore the last session's selection WITHOUT creating a player: no iframe, no
 * YouTube request, no autoplay on boot. The first play loads with `start` set to
 * the stored position, so "resume where I left off" costs nothing until asked.
 */
function hydrateOnce() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const record = readPersisted();
  const cachedProbe = getCachedYouTubePlaybackProbeResult();
  state = {
    ...state,
    environmentFailure: cachedProbe && !cachedProbe.ok ? cachedProbe.failure : null,
  };
  if (!record) return;
  volumeFromStorage = true;
  const known = record.trackId ? getTracks().some((track) => track.id === record.trackId) : false;
  state = {
    ...state,
    volume: record.volume,
    trackId: known ? record.trackId : null,
    currentTime: known ? record.positionSec : 0,
  };
}

function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    const payload: PersistedPlayback = {
      trackId: state.trackId,
      positionSec: Math.max(0, Math.floor(state.currentTime)),
      volume: state.volume,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    volumeFromStorage = true;
  } catch {}
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * What the player is actually told. The user's `volume` is never overwritten by
 * ducking — a voice talking over the music must not survive as a volume change.
 */
function effectiveVolume(): number {
  if (!state.ducked) return state.volume;
  return Math.max(0, Math.round(state.volume * MUSIC_DUCK_RATIO));
}

function applyVolume() {
  bridge?.setVolume(effectiveVolume());
}

/**
 * Duck the music while something else speaks (live agent voice, narration TTS).
 * Ref-counted, so overlapping speakers each hold their own claim; the volume comes
 * back when the last one releases. Idempotent release.
 */
export function duckMusic(): () => void {
  hydrateOnce();
  duckHolders += 1;
  if (duckHolders === 1) {
    setState({ ducked: true });
    applyVolume();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    duckHolders = Math.max(0, duckHolders - 1);
    if (duckHolders === 0) {
      setState({ ducked: false });
      applyVolume();
    }
  };
}

function trackById(trackId: string | null): MusicTrack | null {
  if (!trackId) return null;
  return getTracks().find((track) => track.id === trackId) ?? null;
}

/** The engine's view of the current track (null when the tracklist no longer has it). */
export function getActiveMusicTrack(): MusicTrack | null {
  hydrateOnce();
  return trackById(state.trackId);
}

function logPlayback(fields: Record<string, unknown>) {
  console.info("[music-playback]", fields);
}

/**
 * The environment probe only matters on the non-Tauri path (dev in a browser),
 * where `tauri://` origins are not involved but embedding may still be refused.
 */
function ensureEnvironmentProbe() {
  if (probeStarted || isTauri() || state.environmentFailure) return;
  probeStarted = true;
  void probeYouTubeIframePlayback().then((result) => {
    if (result.ok) return;
    logPlayback({
      adapter: "youtube-iframe",
      status: "blocked",
      reason: result.failure.kind,
      code: result.failure.code,
      origin: resolveYouTubeEmbedOrigin() ?? "unsupported",
    });
    setState({ environmentFailure: result.failure, playing: false });
  });
}

function bridgeCallbacks() {
  return {
    onReady: () => {
      applyVolume();
      if (pendingPlay) bridge?.play();
    },
    onState: (playerState: string) => {
      if (playerState === "playing") {
        pendingPlay = false;
        setState({ playing: true });
        applyVolume();
        return;
      }
      if (playerState === "paused") {
        pendingPlay = false;
        setState({ playing: false });
        persistNow();
        return;
      }
      if (playerState === "ended") {
        pendingPlay = false;
        step(1, true);
      }
    },
    onTime: ({ currentTime, duration }: { currentTime: number; duration: number }) => {
      const track = trackById(state.trackId);
      if (track && !track.durationSec && duration > 0) patchTrack(track.id, { durationSec: duration });
      const now = Date.now();
      if (now - lastTimeUpdate < TIME_UPDATE_MS) return;
      lastTimeUpdate = now;
      setState({ currentTime, duration });
      if (now - lastPositionPersist >= PERSIST_POSITION_MS) {
        lastPositionPersist = now;
        persistNow();
      }
    },
    onError: (code: number) => {
      const failure = classifyYouTubePlayerError(code);
      const trackId = state.trackId;
      pendingPlay = false;
      logPlayback({
        adapter: isTauri() ? "youtube-local-wrapper" : "youtube-iframe",
        status: "error",
        reason: failure.kind,
        code,
        trackId,
        origin: resolveYouTubeEmbedOrigin() ?? "unsupported",
      });
      if (failure.trackScoped && trackId) {
        setState({ playing: false, erroredIds: new Set(state.erroredIds).add(trackId) });
        step(1, true);
        return;
      }
      setState({ playing: false, environmentFailure: failure });
    },
  };
}

/**
 * Bind the engine to the player element. In production that is always the video
 * host's iframe (`music-video-host.ts`), which is created once per session and
 * never re-parented; the surfaces only lend it their rect. Re-attaching the SAME
 * element is a no-op — that is what keeps audio alive across renders. A genuinely
 * new element means the old player is already gone (a dev HMR reload), so the
 * engine heals by reloading the track at its last known position.
 */
export function attachPlayerIframe(element: HTMLIFrameElement | null): void {
  hydrateOnce();
  if (element === iframe) return;
  bridge?.destroy();
  bridge = null;
  iframe = element;
  if (!element) return;
  bridge = createPlayerBridge(element, bridgeCallbacks());
  if (!state.loaded || !state.trackId) return;
  // A load is still resolving its URL; it will write the src into this element.
  if (!loadedUrl) return;
  if (element.src === loadedUrl) {
    applyVolume();
    return;
  }
  void load(state.trackId, { play: state.playing || pendingPlay, startSec: Math.floor(state.currentTime) });
}

/** Write a fresh player URL into the iframe. This IS a reload — track changes only. */
async function load(trackId: string, opts: { play: boolean; startSec?: number }) {
  const track = trackById(trackId);
  if (!track) return;
  const token = ++loadToken;
  const startSec = Math.max(0, Math.floor(opts.startSec ?? 0));
  pendingPlay = opts.play;
  lastTimeUpdate = 0;
  ensureEnvironmentProbe();
  // The video host is the element's permanent home; it exists before any URL does,
  // and from here on only its transform changes as the video moves between slots.
  attachPlayerIframe(ensureVideoHost());
  setVideoHostActive(true);
  setState({
    trackId,
    loaded: true,
    playing: false,
    currentTime: startSec,
    duration: track.durationSec ?? 0,
  });
  persistNow();

  let url: string;
  try {
    url = isTauri()
      ? await musicYoutubePlayerUrl(track.videoId, opts.play, startSec)
      : youtubeEmbedUrl(track.videoId, {
          autoplay: opts.play,
          origin: resolveYouTubeEmbedOrigin(),
          startSec,
        });
  } catch (error) {
    if (token !== loadToken) return;
    pendingPlay = false;
    logPlayback({
      adapter: "youtube-local-wrapper",
      status: "url-error",
      message: error instanceof Error ? error.message : String(error),
    });
    setVideoHostActive(false);
    setState({ loaded: false, playing: false });
    return;
  }
  if (token !== loadToken) return;
  loadedUrl = url;
  if (iframe) iframe.src = url;
}

/** Play a specific track. Same track already loaded → resume, never reload. */
export function playTrack(trackId: string): void {
  hydrateOnce();
  if (trackId === state.trackId && state.loaded) {
    pendingPlay = true;
    bridge?.play();
    return;
  }
  const resumeAt = trackId === state.trackId ? Math.floor(state.currentTime) : 0;
  void load(trackId, { play: true, startSec: resumeAt });
}

/** Select a track without starting playback (a node restoring its `activeTrackId`). */
export function selectTrack(trackId: string): void {
  hydrateOnce();
  if (state.trackId === trackId) return;
  if (state.loaded) {
    void load(trackId, { play: state.playing || pendingPlay, startSec: 0 });
    return;
  }
  setState({ trackId, currentTime: 0, duration: trackById(trackId)?.durationSec ?? 0 });
  persistSoon();
}

/**
 * Start or resume — never a toggle. This is what an OS "play" command means, and it
 * must be a no-op when playback is already running.
 */
export function resumePlayback(): void {
  hydrateOnce();
  const trackId = state.trackId;
  if (!trackId || state.playing) return;
  if (!state.loaded) {
    void load(trackId, { play: true, startSec: Math.floor(state.currentTime) });
    return;
  }
  pendingPlay = true;
  bridge?.play();
}

export function togglePlay(): void {
  hydrateOnce();
  if (!state.trackId) return;
  if (state.playing) {
    pause();
    return;
  }
  resumePlayback();
}

export function pause(): void {
  hydrateOnce();
  if (!state.loaded) return;
  pendingPlay = false;
  bridge?.pause();
  setState({ playing: false });
  persistNow();
}

/** Step to the neighbouring playable track, skipping embed-disallowed ones. */
function step(direction: 1 | -1, play: boolean) {
  const current = state.trackId;
  const tracks = getTracks();
  if (!current || tracks.length === 0) return;
  let id: string | null = current;
  for (let i = 0; i < tracks.length; i += 1) {
    id = direction === 1 ? nextTrackId(id ?? current) : prevTrackId(id ?? current);
    if (!id || id === current) break;
    if (!state.erroredIds.has(id)) {
      void load(id, { play, startSec: 0 });
      return;
    }
  }
  setState({ playing: false });
}

export function next(): void {
  hydrateOnce();
  step(1, state.playing || pendingPlay);
}

export function prev(): void {
  hydrateOnce();
  step(-1, state.playing || pendingPlay);
}

export function seek(seconds: number): void {
  hydrateOnce();
  const target = Math.max(0, Math.floor(seconds));
  bridge?.seekTo(target);
  setState({ currentTime: target });
  persistSoon();
}

export function setVolume(volume: number): void {
  hydrateOnce();
  const next = Math.max(0, Math.min(100, Math.round(volume)));
  setState({ volume: next });
  // While ducked the player hears the reduced value; `volume` is still what the user
  // chose, so releasing the duck restores exactly this level.
  applyVolume();
  persistSoon();
}

/**
 * One-time migration: v1 stored volume per node. Adopt it only when this session
 * has no playback record of its own, so a node never overwrites the global volume.
 */
export function adoptLegacyNodeVolume(volume: number | undefined): void {
  hydrateOnce();
  if (volumeFromStorage || typeof volume !== "number" || !Number.isFinite(volume)) return;
  volumeFromStorage = true;
  setState({ volume: Math.max(0, Math.min(100, Math.round(volume))) });
}

/**
 * Tear the player down (the dock's close button). The selection and position are
 * kept, so pressing play again resumes exactly where it stopped.
 */
export function stopPlayback(): void {
  hydrateOnce();
  loadToken += 1;
  pendingPlay = false;
  loadedUrl = null;
  if (iframe) iframe.removeAttribute("src");
  setVideoHostActive(false);
  setState({ loaded: false, playing: false });
  persistNow();
}

/** A track left the tracklist: advance when it was the active one, else nothing. */
export function handleTrackRemoved(trackId: string): void {
  hydrateOnce();
  if (state.trackId !== trackId) return;
  const remaining = getTracks().filter((track) => track.id !== trackId);
  if (remaining.length === 0) {
    loadToken += 1;
    pendingPlay = false;
    loadedUrl = null;
    if (iframe) iframe.removeAttribute("src");
    setVideoHostActive(false);
    setState({ trackId: null, loaded: false, playing: false, currentTime: 0, duration: 0 });
    persistNow();
    return;
  }
  const wasPlaying = state.playing || pendingPlay;
  const fallback = nextTrackId(trackId);
  const target = fallback && fallback !== trackId ? fallback : remaining[0].id;
  if (state.loaded) void load(target, { play: wasPlaying, startSec: 0 });
  else setState({ trackId: target, currentTime: 0, duration: trackById(target)?.durationSec ?? 0 });
}

export function getMusicEngineState(): MusicEngineState {
  hydrateOnce();
  return state;
}

export function subscribeMusicEngine(listener: () => void): () => void {
  hydrateOnce();
  listeners.add(listener);
  // A deleted/renamed track changes what the engine's own state means, so the
  // tracklist store is part of this subscription.
  const unsubscribeTracklist = subscribeTracklist(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeTracklist();
  };
}

const getServerSnapshot = (): MusicEngineState => state;

/** React binding — re-renders on any playback change. */
export function useMusicEngine(): MusicEngineState {
  return useSyncExternalStore(subscribeMusicEngine, getMusicEngineState, getServerSnapshot);
}

/** Test-only: drop all engine state (and the persisted record unless kept). */
export function resetMusicEngineForTests(opts?: { keepStorage?: boolean }) {
  bridge?.destroy();
  bridge = null;
  iframe = null;
  loadedUrl = null;
  pendingPlay = false;
  loadToken = 0;
  lastTimeUpdate = 0;
  lastPositionPersist = 0;
  probeStarted = false;
  volumeFromStorage = false;
  hydrated = false;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  listeners.clear();
  state = {
    trackId: null,
    loaded: false,
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: DEFAULT_MUSIC_VOLUME,
    ducked: false,
    erroredIds: EMPTY_ERRORED,
    environmentFailure: null,
  };
  if (!opts?.keepStorage) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
}
