import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishNowPlaying, resetNowPlayingForTests, type NowPlayingHandlers } from "./music-now-playing";

interface StubSession {
  metadata: unknown;
  playbackState: string;
  setActionHandler: ReturnType<typeof vi.fn>;
  setPositionState: ReturnType<typeof vi.fn>;
}

let session: StubSession;
let handlers: NowPlayingHandlers;

function actionHandler(action: string): ((details?: unknown) => void) | undefined {
  const call = session.setActionHandler.mock.calls.find(([name]) => name === action);
  return call?.[1];
}

const SNAPSHOT = {
  title: "Melodic Techno 2026 Mix",
  artist: "Lotus Test",
  artworkUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  playing: true,
  duration: 300,
  position: 28,
};

beforeEach(() => {
  resetNowPlayingForTests();
  session = {
    metadata: null,
    playbackState: "none",
    setActionHandler: vi.fn(),
    setPositionState: vi.fn(),
  };
  Object.defineProperty(navigator, "mediaSession", { value: session, configurable: true });
  // jsdom has no MediaMetadata; the shape is all this module needs.
  (globalThis as { MediaMetadata?: unknown }).MediaMetadata = class {
    constructor(public init: unknown) {}
  };
  handlers = { play: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(), seek: vi.fn() };
});

afterEach(() => {
  delete (globalThis as { MediaMetadata?: unknown }).MediaMetadata;
  vi.restoreAllMocks();
});

describe("publishNowPlaying", () => {
  it("publishes metadata, playback state, and position", () => {
    publishNowPlaying(SNAPSHOT, handlers);

    expect((session.metadata as { init: Record<string, unknown> }).init).toMatchObject({
      title: SNAPSHOT.title,
      artist: SNAPSHOT.artist,
      artwork: [{ src: SNAPSHOT.artworkUrl, sizes: "480x360", type: "image/jpeg" }],
    });
    expect(session.playbackState).toBe("playing");
    expect(session.setPositionState).toHaveBeenCalledWith({ duration: 300, position: 28, playbackRate: 1 });
  });

  it("routes OS transport commands to the engine callbacks", () => {
    publishNowPlaying(SNAPSHOT, handlers);

    actionHandler("play")?.();
    actionHandler("pause")?.();
    actionHandler("nexttrack")?.();
    actionHandler("previoustrack")?.();
    actionHandler("seekto")?.({ seekTime: 120 });

    expect(handlers.play).toHaveBeenCalledOnce();
    expect(handlers.pause).toHaveBeenCalledOnce();
    expect(handlers.next).toHaveBeenCalledOnce();
    expect(handlers.prev).toHaveBeenCalledOnce();
    expect(handlers.seek).toHaveBeenCalledWith(120);
  });

  it("ignores a seekto without a usable time", () => {
    publishNowPlaying(SNAPSHOT, handlers);
    actionHandler("seekto")?.({});
    actionHandler("seekto")?.({ seekTime: Number.NaN });
    expect(handlers.seek).not.toHaveBeenCalled();
  });

  it("rebuilds metadata only when the track changes", () => {
    publishNowPlaying(SNAPSHOT, handlers);
    const first = session.metadata;

    publishNowPlaying({ ...SNAPSHOT, position: 33 }, handlers);
    expect(session.metadata).toBe(first); // a time tick must not churn OS metadata
    expect(session.setPositionState).toHaveBeenCalledTimes(2);

    publishNowPlaying({ ...SNAPSHOT, title: "Another Track" }, handlers);
    expect(session.metadata).not.toBe(first);
  });

  it("does not re-publish a steadily advancing position or a repeated clear", () => {
    vi.useFakeTimers();
    try {
      publishNowPlaying(SNAPSHOT, handlers);
      vi.advanceTimersByTime(500);
      publishNowPlaying({ ...SNAPSHOT, position: 28.5 }, handlers); // the engine's 500 ms tick
      vi.advanceTimersByTime(500);
      publishNowPlaying({ ...SNAPSHOT, position: 29 }, handlers);
      expect(session.setPositionState).toHaveBeenCalledTimes(1);

      publishNowPlaying({ ...SNAPSHOT, position: 29, playing: false }, handlers); // pause
      publishNowPlaying({ ...SNAPSHOT, position: 120, playing: false }, handlers); // seek
      expect(session.setPositionState).toHaveBeenCalledTimes(3);

      publishNowPlaying(null, handlers);
      publishNowPlaying(null, handlers);
      expect(session.setPositionState).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps a position past the duration instead of throwing", () => {
    session.setPositionState.mockImplementation((positionState?: { position?: number; duration?: number }) => {
      if ((positionState?.position ?? 0) > (positionState?.duration ?? 0)) throw new TypeError("bad position");
    });
    publishNowPlaying({ ...SNAPSHOT, position: 999 }, handlers);
    expect(session.setPositionState).toHaveBeenCalledWith({ duration: 300, position: 300, playbackRate: 1 });
  });

  it("skips position entirely while the duration is unknown", () => {
    publishNowPlaying({ ...SNAPSHOT, duration: 0 }, handlers);
    expect(session.setPositionState).not.toHaveBeenCalled();
    expect(session.playbackState).toBe("playing");
  });

  it("clears the OS surface when there is nothing loaded", () => {
    publishNowPlaying(SNAPSHOT, handlers);
    publishNowPlaying(null, handlers);

    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(session.setPositionState).toHaveBeenLastCalledWith();
  });

  it("is a no-op where the Media Session API does not exist", () => {
    Object.defineProperty(navigator, "mediaSession", { value: undefined, configurable: true });
    expect(() => publishNowPlaying(SNAPSHOT, handlers)).not.toThrow();
  });
});
