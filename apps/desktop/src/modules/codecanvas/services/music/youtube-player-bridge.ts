/**
 * Custom transport chrome ↔ YouTube iframe, over the raw IFrame-API postMessage
 * protocol (plan §3c). No external SDK script: the node is a static Tauri bundle,
 * so we speak the widget protocol directly — send `listening` to open the info
 * stream, `command` to drive playback, and decode `infoDelivery`/`onError`
 * messages coming back. Everything is message-passing, so the whole bridge is
 * unit-testable in jsdom without a real player.
 */

const YOUTUBE_ORIGIN = "https://www.youtube.com";

function playerMessageTargetOrigin(iframe: HTMLIFrameElement): string {
  try {
    const origin = new URL(iframe.src).origin;
    return origin && origin !== "null" ? origin : YOUTUBE_ORIGIN;
  } catch {
    return YOUTUBE_ORIGIN;
  }
}

export type PlayerStateName = "unstarted" | "ended" | "playing" | "paused" | "buffering" | "cued";

/** YouTube playerState codes → names (IFrame API contract). */
const STATE_NAMES: Record<number, PlayerStateName> = {
  [-1]: "unstarted",
  0: "ended",
  1: "playing",
  2: "paused",
  3: "buffering",
  5: "cued",
};

export interface PlayerBridgeCallbacks {
  /** The iframe player accepted the widget handshake and is ready enough to use. */
  onReady?: () => void;
  /** Playback state transitions (playing/paused/ended/…). */
  onState?: (state: PlayerStateName) => void;
  /** Time stream from infoDelivery — throttle on the consumer side if needed. */
  onTime?: (info: { currentTime: number; duration: number }) => void;
  /** Player error codes; 101/150 = embedding disallowed for this video. */
  onError?: (code: number) => void;
}

export interface PlayerBridge {
  play(): void;
  pause(): void;
  /** Seek to an absolute position (seconds). */
  seekTo(seconds: number): void;
  /** 0..100, YouTube's own volume scale. */
  setVolume(volume: number): void;
  /** Detach all listeners; the bridge is inert afterwards. */
  destroy(): void;
}

export function createPlayerBridge(iframe: HTMLIFrameElement, callbacks: PlayerBridgeCallbacks): PlayerBridge {
  const post = (payload: Record<string, unknown>) => {
    iframe.contentWindow?.postMessage(JSON.stringify({ ...payload, channel: "widget" }), playerMessageTargetOrigin(iframe));
  };
  const command = (func: string, args: unknown[] = []) => post({ event: "command", func, args });
  // The player only streams infoDelivery after hearing `listening`; the iframe may
  // not have loaded yet when the bridge is created, so re-send on every load.
  // The player sends infoDelivery several times a second, and answers every command
  // (setVolume, playVideo) with another one. Consumers react to onReady/onState by
  // sending commands, so forwarding repeats made a postMessage feedback loop
  // (~1.5k setVolume/s, 100% WebContent CPU). Forward each only once per change.
  let ready = false;
  let lastState: PlayerStateName | null = null;
  // A new src (track change) or a reload is a new player: ready + state start over.
  let playerSrc = iframe.src;
  const reset = () => {
    playerSrc = iframe.src;
    ready = false;
    lastState = null;
  };
  const resetIfNewPlayer = () => {
    if (iframe.src !== playerSrc) reset();
  };
  const sendListening = () => post({ event: "listening" });
  const onLoad = () => {
    reset();
    sendListening();
  };
  const markReady = () => {
    if (ready) return;
    ready = true;
    callbacks.onReady?.();
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    let data: unknown = event.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (typeof data !== "object" || data === null) return;
    const message = data as { event?: string; info?: unknown };
    resetIfNewPlayer();

    if (message.event === "onReady") {
      markReady();
      return;
    }
    if (message.event === "onError") {
      const code = Number(message.info);
      if (Number.isFinite(code)) callbacks.onError?.(code);
      return;
    }
    if (message.event !== "infoDelivery" || typeof message.info !== "object" || message.info === null) return;
    markReady();
    const info = message.info as { currentTime?: unknown; duration?: unknown; playerState?: unknown };
    if (typeof info.playerState === "number") {
      const state = STATE_NAMES[info.playerState];
      if (state && state !== lastState) {
        lastState = state;
        callbacks.onState?.(state);
      }
    }
    if (typeof info.currentTime === "number" && typeof info.duration === "number") {
      callbacks.onTime?.({ currentTime: info.currentTime, duration: info.duration });
    }
  };

  window.addEventListener("message", onMessage);
  iframe.addEventListener("load", onLoad);
  sendListening();

  return {
    play: () => command("playVideo"),
    pause: () => command("pauseVideo"),
    seekTo: (seconds: number) => command("seekTo", [seconds, true]),
    setVolume: (volume: number) => command("setVolume", [Math.max(0, Math.min(100, volume))]),
    destroy: () => {
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", onLoad);
    },
  };
}
