/**
 * OS "Now Playing" surface for the music engine (plan
 * `plans/canvas-music-persistent-playback/PLAN.md` Tahap 3).
 *
 * A pure SINK: it never imports the engine, it is handed a snapshot plus the
 * callbacks the OS should be able to invoke. That keeps the dependency one-way
 * (engine → here) and makes the whole thing testable with a stub `mediaSession`.
 *
 * Standards path, and it is enough here. WKWebView implements the Media Session API,
 * so `navigator.mediaSession` reaches macOS Control Center and the F7/F8/F9 media
 * keys with no objc and no extra Rust surface. The open question was whether the
 * *top-level* page wins the Now Playing slot while the audible element is a
 * cross-origin YouTube iframe (which registers a media session of its own) — an
 * empirical question about this exact webview. Verified working in the app on
 * 2026-08-10, so the MPNowPlayingInfoCenter / MPRemoteCommandCenter fallback in Rust
 * was deliberately NOT written: nothing showed it was needed.
 */

export interface NowPlayingSnapshot {
  title: string;
  artist: string;
  artworkUrl?: string;
  playing: boolean;
  /** Seconds; omitted/0 means unknown (a live stream, or duration not in yet). */
  duration: number;
  position: number;
}

export interface NowPlayingHandlers {
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
}

type MediaSessionLike = {
  metadata: unknown;
  playbackState: "none" | "paused" | "playing";
  setActionHandler: (action: string, handler: ((details?: unknown) => void) | null) => void;
  setPositionState?: (state?: { duration?: number; position?: number; playbackRate?: number }) => void;
};

let handlersBound = false;
/** Identity of the metadata currently published — rebuilding it every tick is waste. */
let publishedMetadataKey: string | null = null;
/**
 * The position the OS was last given. The OS extrapolates a playing position on its
 * own, so steady playback needs no re-publish; every write here costs WebKit a full
 * media-session status update across all sessions.
 */
let publishedPosition: { playing: boolean; duration: number; position: number; at: number } | null = null;
let cleared = false;
/** A position this far from where the OS already thinks it is counts as a seek. */
const POSITION_DRIFT_SEC = 2;

function mediaSession(): MediaSessionLike | null {
  if (typeof navigator === "undefined") return null;
  const candidate = (navigator as Navigator & { mediaSession?: MediaSessionLike }).mediaSession;
  return candidate && typeof candidate.setActionHandler === "function" ? candidate : null;
}

function bindHandlers(session: MediaSessionLike, handlers: NowPlayingHandlers) {
  if (handlersBound) return;
  handlersBound = true;
  const bind = (action: string, handler: (details?: unknown) => void) => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // Unsupported action on this platform — the others still work.
    }
  };
  bind("play", () => handlers.play());
  bind("pause", () => handlers.pause());
  bind("previoustrack", () => handlers.prev());
  bind("nexttrack", () => handlers.next());
  bind("stop", () => handlers.pause());
  bind("seekto", (details) => {
    const seekTime = (details as { seekTime?: unknown } | undefined)?.seekTime;
    if (typeof seekTime === "number" && Number.isFinite(seekTime)) handlers.seek(seekTime);
  });
}

/**
 * Publish (or clear, with `null`) what the OS should show and be able to control.
 * Safe to call on every engine tick: metadata is only rebuilt when the track
 * changes, and unsupported platforms are a no-op.
 */
export function publishNowPlaying(snapshot: NowPlayingSnapshot | null, handlers: NowPlayingHandlers): void {
  const session = mediaSession();
  if (!session) return;

  if (!snapshot) {
    if (cleared) return;
    cleared = true;
    publishedPosition = null;
    publishedMetadataKey = null;
    session.metadata = null;
    session.playbackState = "none";
    try {
      session.setPositionState?.();
    } catch {}
    return;
  }

  cleared = false;
  bindHandlers(session, handlers);

  const metadataKey = `${snapshot.title}|${snapshot.artist}|${snapshot.artworkUrl ?? ""}`;
  const MetadataCtor = (globalThis as { MediaMetadata?: new (init: unknown) => unknown }).MediaMetadata;
  if (metadataKey !== publishedMetadataKey && MetadataCtor) {
    publishedMetadataKey = metadataKey;
    publishedPosition = null;
    session.metadata = new MetadataCtor({
      title: snapshot.title,
      artist: snapshot.artist,
      album: "Lotus",
      artwork: snapshot.artworkUrl
        ? [{ src: snapshot.artworkUrl, sizes: "480x360", type: "image/jpeg" }]
        : [],
    });
  }

  const playbackState = snapshot.playing ? "playing" : "paused";
  if (session.playbackState !== playbackState) session.playbackState = playbackState;

  // setPositionState throws on incoherent input (position past duration, zero
  // duration), and a throw here would take the engine's emit down with it.
  const now = Date.now();
  const last = publishedPosition;
  const expected = last ? last.position + (last.playing ? (now - last.at) / 1000 : 0) : Number.NaN;
  const unchanged =
    last !== null &&
    last.playing === snapshot.playing &&
    last.duration === snapshot.duration &&
    Math.abs(expected - snapshot.position) <= POSITION_DRIFT_SEC;
  if (snapshot.duration > 0 && !unchanged) {
    publishedPosition = { playing: snapshot.playing, duration: snapshot.duration, position: snapshot.position, at: now };
    try {
      session.setPositionState?.({
        duration: snapshot.duration,
        position: Math.max(0, Math.min(snapshot.position, snapshot.duration)),
        playbackRate: 1,
      });
    } catch {}
  }
}

/** Test-only: forget bound handlers + published metadata identity. */
export function resetNowPlayingForTests(): void {
  handlersBound = false;
  publishedMetadataKey = null;
  publishedPosition = null;
  cleared = false;
}
