import { createPlayerBridge, type PlayerBridge } from "./youtube-player-bridge";
import { youtubeEmbedUrl } from "./music-track";

export const YOUTUBE_PROBE_VIDEO_ID = "M7lc1UVf-VE";

export type YouTubePlaybackFailureKind =
  | "embed-disallowed"
  | "player-config"
  | "player-unavailable";

export interface YouTubePlaybackFailure {
  kind: YouTubePlaybackFailureKind;
  code?: number;
  trackScoped: boolean;
  badge: string;
  message: string;
}

export type YouTubePlaybackProbeResult =
  | { ok: true; checkedAt: number }
  | { ok: false; checkedAt: number; failure: YouTubePlaybackFailure };

export function resolveYouTubeEmbedOrigin(loc: Pick<Location, "origin" | "protocol"> | null | undefined = typeof window !== "undefined" ? window.location : undefined): string | undefined {
  if (!loc || loc.origin === "null") return undefined;
  if (loc.protocol !== "http:" && loc.protocol !== "https:") return undefined;
  return loc.origin;
}

export function classifyYouTubePlayerError(code: number): YouTubePlaybackFailure {
  if (code === 101 || code === 150) {
    return {
      kind: "embed-disallowed",
      code,
      trackScoped: true,
      badge: "NO EMBED",
      message: "This video does not allow embedded playback.",
    };
  }
  if (code === 153) {
    return {
      kind: "player-config",
      code,
      trackScoped: false,
      badge: "DESKTOP BLOCKED",
      message: "YouTube blocked embedded playback in this desktop build.",
    };
  }
  return {
    kind: "player-unavailable",
    code,
    trackScoped: false,
    badge: "PLAYER ERROR",
    message: `YouTube player error ${code}.`,
  };
}

let cachedProbe: Promise<YouTubePlaybackProbeResult> | null = null;
let cachedProbeResult: YouTubePlaybackProbeResult | null = null;

export function resetYouTubePlaybackProbeCacheForTests() {
  cachedProbe = null;
  cachedProbeResult = null;
}

export function getCachedYouTubePlaybackProbeResult(): YouTubePlaybackProbeResult | null {
  return cachedProbeResult;
}

export interface ProbeYouTubeIframePlaybackOptions {
  videoId?: string;
  timeoutMs?: number;
  root?: HTMLElement;
  now?: () => number;
}

export function probeYouTubeIframePlayback(opts: ProbeYouTubeIframePlaybackOptions = {}): Promise<YouTubePlaybackProbeResult> {
  if (cachedProbeResult) return Promise.resolve(cachedProbeResult);
  if (cachedProbe) return cachedProbe;
  if (typeof document === "undefined") {
    cachedProbeResult = {
      ok: false,
      checkedAt: opts.now?.() ?? Date.now(),
      failure: {
        kind: "player-unavailable",
        trackScoped: false,
        badge: "PLAYER ERROR",
        message: "YouTube playback probe is unavailable outside the browser.",
      },
    };
    return Promise.resolve(cachedProbeResult);
  }

  cachedProbe = new Promise<YouTubePlaybackProbeResult>((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const checkedAt = () => opts.now?.() ?? Date.now();
    const iframe = document.createElement("iframe");
    let bridge: PlayerBridge | null = null;
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      bridge?.destroy();
      bridge = null;
      iframe.remove();
    };

    const finish = (result: YouTubePlaybackProbeResult) => {
      if (done) return;
      done = true;
      cachedProbeResult = result;
      cleanup();
      resolve(result);
    };

    iframe.style.position = "fixed";
    iframe.style.left = "-10000px";
    iframe.style.top = "0";
    iframe.style.width = "220px";
    iframe.style.height = "220px";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.src = youtubeEmbedUrl(opts.videoId ?? YOUTUBE_PROBE_VIDEO_ID, {
      origin: resolveYouTubeEmbedOrigin(),
    });

    bridge = createPlayerBridge(iframe, {
      onReady: () => finish({ ok: true, checkedAt: checkedAt() }),
      onState: () => finish({ ok: true, checkedAt: checkedAt() }),
      onTime: () => finish({ ok: true, checkedAt: checkedAt() }),
      onError: (code) => finish({ ok: false, checkedAt: checkedAt(), failure: classifyYouTubePlayerError(code) }),
    });

    timeout = setTimeout(() => {
      finish({
        ok: false,
        checkedAt: checkedAt(),
        failure: {
          kind: "player-unavailable",
          trackScoped: false,
          badge: "PLAYER TIMEOUT",
          message: "YouTube embedded player did not become ready in this desktop build.",
        },
      });
    }, timeoutMs);

    (opts.root ?? document.body).appendChild(iframe);
  }).finally(() => {
    cachedProbe = null;
  });

  return cachedProbe;
}
