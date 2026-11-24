/**
 * Music node track model — YouTube URL parsing + track construction (plan
 * `plans/canvas-music-player/PLAN.md` §2/§3a). Pure module: no DOM, no Tauri,
 * so the URL matrix is unit-testable. The oEmbed metadata fetch lives on the
 * Rust side (`music_resolve_track`); this module owns everything derivable
 * from the URL alone.
 */

export interface MusicTrack {
  /** Stable uuid — the tracklist CRUD key (rename/delete/reorder target). */
  id: string;
  /** 11-char YouTube video id parsed from the pasted URL. */
  videoId: string;
  /** The URL as pasted, kept for provenance / re-copy. */
  url: string;
  /** oEmbed title. */
  title: string;
  /** oEmbed author_name (channel). */
  author: string;
  /** oEmbed thumbnail_url. */
  thumbnailUrl: string;
  /** Backfilled from the player's getDuration once the track first plays. */
  durationSec?: number;
  /** Epoch ms when the track entered the tracklist. */
  addedAt: number;
}

/** Metadata resolved by the Rust `music_resolve_track` command (YouTube oEmbed). */
export interface MusicTrackMeta {
  title: string;
  author: string;
  thumbnailUrl: string;
}

export interface CreateMusicTrackOptions {
  url: string;
  videoId: string;
  meta: MusicTrackMeta;
  /** Injectable for tests; defaults to a fresh uuid. */
  id?: string;
  /** Injectable for tests; defaults to Date.now(). */
  addedAt?: number;
}

export function createMusicTrack(opts: CreateMusicTrackOptions): MusicTrack {
  return {
    id: opts.id ?? crypto.randomUUID(),
    videoId: opts.videoId,
    url: opts.url,
    title: opts.meta.title,
    author: opts.meta.author,
    thumbnailUrl: opts.meta.thumbnailUrl,
    addedAt: opts.addedAt ?? Date.now(),
  };
}

/**
 * Embed URL for the player iframe. `enablejsapi=1` lets the player bridge drive it
 * over postMessage; `playsinline=1` keeps mobile-style hosts from going fullscreen
 * on play. `startSec` is the resume position and is fixed for the life of one load —
 * deriving it from the live currentTime would rewrite `src` every tick, and every
 * `src` write reloads the player.
 */
export function youtubeEmbedUrl(videoId: string, opts?: { autoplay?: boolean; origin?: string | null; startSec?: number }): string {
  const params = new URLSearchParams({
    enablejsapi: "1",
    playsinline: "1",
    autoplay: opts?.autoplay ? "1" : "0",
  });
  if (opts?.origin && /^https?:\/\//i.test(opts.origin)) params.set("origin", opts.origin);
  const startSec = opts?.startSec;
  if (typeof startSec === "number" && Number.isFinite(startSec) && startSec > 0) {
    params.set("start", String(Math.floor(startSec)));
  }
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Extract the 11-char video id from any common YouTube URL shape, or null when it isn't one. */
export function parseYoutubeVideoId(url: string): string | null {
  const raw = url.trim();
  let parsed: URL;
  try {
    // Users routinely paste scheme-less links ("youtube.com/watch?v=…"); default to https.
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");

  if (host === "youtu.be") {
    const id = parsed.pathname.split("/")[1] ?? "";
    return VIDEO_ID.test(id) ? id : null;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const v = parsed.searchParams.get("v");
    if (v && VIDEO_ID.test(v)) return v;
    // Path-based shapes: /shorts/<id>, /embed/<id>, /live/<id>
    const [, kind, id = ""] = parsed.pathname.split("/");
    if ((kind === "shorts" || kind === "embed" || kind === "live") && VIDEO_ID.test(id)) return id;
  }
  return null;
}
