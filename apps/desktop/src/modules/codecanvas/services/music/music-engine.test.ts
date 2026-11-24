import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { isTauri, musicYoutubePlayerUrl } from "@/lib/tauri-api";
import {
  MUSIC_DUCK_RATIO,
  adoptLegacyNodeVolume,
  attachPlayerIframe,
  duckMusic,
  getMusicEngineState,
  handleTrackRemoved,
  next,
  playTrack,
  prev,
  resetMusicEngineForTests,
  seek,
  setVolume,
  stopPlayback,
  togglePlay,
} from "./music-engine";
import { createMusicTrack, type MusicTrack } from "./music-track";
import { addTrack, resetMusicTracklistStoreForTests } from "./music-tracklist-store";
import {
  ensureVideoHost,
  getVideoPlayerElement,
  isVideoHostActive,
  resetVideoHostForTests,
} from "./music-video-host";

vi.mock("@/lib/tauri-api", () => ({
  isTauri: vi.fn(() => true),
  musicResolveTrack: vi.fn(),
  musicYoutubePlayerUrl: vi.fn(),
}));

const WRAPPER_ORIGIN = "http://127.0.0.1:9877";

let iframe: HTMLIFrameElement;
let posted: Mock;

function wrapperUrl(videoId: string, autoplay: boolean, startSec?: number): string {
  const start = startSec && startSec > 0 ? `&start=${startSec}` : "";
  return `${WRAPPER_ORIGIN}/api/music/youtube-player?videoId=${videoId}&autoplay=${autoplay}${start}`;
}

function track(videoId: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return addTrack(
    createMusicTrack({
      id: overrides.id ?? `track-${videoId}`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      meta: {
        title: overrides.title ?? `Track ${videoId}`,
        author: "Lotus Test",
        thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      },
      addedAt: 1,
    }),
  );
}

/**
 * The production element: the session's video host iframe. Attaching it up front
 * mirrors what `load()` does, and lets the spy sit on its contentWindow.
 */
function mountIframe(): HTMLIFrameElement {
  const element = ensureVideoHost();
  posted = vi.fn();
  vi.spyOn(element.contentWindow!, "postMessage").mockImplementation(posted);
  attachPlayerIframe(element);
  return element;
}

/**
 * Writing `src` navigates the frame, and jsdom hands back a fresh `contentWindow` —
 * so the spy has to be re-installed on the live one before asserting commands
 * (same dance as `youtube-player-bridge.test.ts`).
 */
function resyncPostMessageSpy() {
  posted = vi.fn();
  vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(posted);
}

function sentPayloads(): Array<Record<string, unknown>> {
  return posted.mock.calls.map(([data]) => JSON.parse(data as string));
}

function sentFuncs(): string[] {
  return sentPayloads()
    .filter((payload) => payload.event === "command")
    .map((payload) => String(payload.func));
}

/** Simulate a message coming FROM the player. */
function playerMessage(data: unknown, source: Window | null = iframe.contentWindow) {
  window.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data), origin: "https://www.youtube.com", source }),
  );
}

function playerState(playerState: number, info: Record<string, unknown> = {}) {
  playerMessage({ event: "infoDelivery", info: { playerState, ...info } });
}

beforeEach(() => {
  localStorage.clear();
  resetMusicTracklistStoreForTests();
  resetMusicEngineForTests();
  resetVideoHostForTests();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(musicYoutubePlayerUrl).mockReset();
  vi.mocked(musicYoutubePlayerUrl).mockImplementation(
    async (videoId: string, autoplay: boolean, startSec?: number) => wrapperUrl(videoId, autoplay, startSec),
  );
  iframe = mountIframe();
});

afterEach(() => {
  attachPlayerIframe(null);
  resetVideoHostForTests();
  document.querySelectorAll("iframe").forEach((el) => el.remove());
  vi.restoreAllMocks();
});

describe("loading a track", () => {
  it("writes the wrapper URL and plays once the player is ready", async () => {
    const saved = track("dQw4w9WgXcQ");
    playTrack(saved.id);
    await vi.waitFor(() => expect(iframe.src).toBe(wrapperUrl("dQw4w9WgXcQ", true)));

    expect(getMusicEngineState()).toMatchObject({ trackId: saved.id, loaded: true, playing: false });
    resyncPostMessageSpy();
    playerMessage({ event: "onReady" });
    expect(sentFuncs()).toEqual(["setVolume", "playVideo"]);

    playerState(1, { currentTime: 0, duration: 210 });
    expect(getMusicEngineState().playing).toBe(true);
  });

  it("keeps the play pending instead of claiming playback before the wrapper URL resolves", async () => {
    const saved = track("dQw4w9WgXcQ");
    let resolveUrl: (url: string) => void = () => {};
    vi.mocked(musicYoutubePlayerUrl).mockReturnValue(new Promise((resolve) => { resolveUrl = resolve; }));

    playTrack(saved.id);
    // `loaded` flips immediately so the surface that owns the iframe renders it,
    // but nothing is playing and no src has been written yet.
    expect(getMusicEngineState()).toMatchObject({ loaded: true, playing: false });
    expect(iframe.src).toBe("");

    resolveUrl(wrapperUrl("dQw4w9WgXcQ", true));
    await vi.waitFor(() => expect(iframe.src).toBe(wrapperUrl("dQw4w9WgXcQ", true)));
  });

  it("ignores a slow URL resolve that a newer load already superseded", async () => {
    const first = track("dQw4w9WgXcQ");
    const second = track("WPni755-Krg");
    let resolveFirst: (url: string) => void = () => {};
    vi.mocked(musicYoutubePlayerUrl).mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));

    playTrack(first.id);
    playTrack(second.id);
    await vi.waitFor(() => expect(iframe.src).toBe(wrapperUrl("WPni755-Krg", true)));

    resolveFirst(wrapperUrl("dQw4w9WgXcQ", true));
    await Promise.resolve();
    expect(iframe.src).toBe(wrapperUrl("WPni755-Krg", true));
    expect(getMusicEngineState().trackId).toBe(second.id);
  });

  it("builds the direct embed URL (with origin + start) outside Tauri", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const saved = track("dQw4w9WgXcQ");
    playTrack(saved.id);
    seek(45);
    stopPlayback();
    playTrack(saved.id);

    await vi.waitFor(() => expect(iframe.src).toContain("https://www.youtube.com/embed/dQw4w9WgXcQ?"));
    expect(iframe.src).toContain("start=45");
    expect(musicYoutubePlayerUrl).not.toHaveBeenCalled();
  });
});

describe("playback survives the surfaces that host it", () => {
  it("does not reload the player on pause/play — the reload bug that restarted the track", async () => {
    const saved = track("dQw4w9WgXcQ");
    playTrack(saved.id);
    await vi.waitFor(() => expect(iframe.src).not.toBe(""));
    const loadedSrc = iframe.src;
    resyncPostMessageSpy();
    playerMessage({ event: "onReady" });
    playerState(1, { currentTime: 12, duration: 210 });

    togglePlay();
    expect(getMusicEngineState().playing).toBe(false);
    expect(sentFuncs()).toContain("pauseVideo");
    togglePlay();

    // The whole cycle happened over postMessage: the URL never changed, so the player
    // was never rebuilt (v1 flipped `autoplay` inside the src and restarted the track).
    expect(iframe.src).toBe(loadedSrc);
    expect(sentFuncs().filter((func) => func === "pauseVideo")).toHaveLength(1);
    expect(sentFuncs().at(-1)).toBe("playVideo");
  });

  it("keeps the same element and URL playing when a music node unmounts (project switch)", async () => {
    const saved = track("dQw4w9WgXcQ");
    playTrack(saved.id);
    await vi.waitFor(() => expect(iframe.src).not.toBe(""));
    playerMessage({ event: "onReady" });
    playerState(1, { currentTime: 30, duration: 210 });
    const loadedSrc = iframe.src;
    const element = iframe;

    // A project switch replaces the canvas node array: every MusicNode unmounts and
    // remounts. The engine's element is owned by the app shell, so re-attaching the
    // SAME element must be a no-op — no new src, no reload, audio untouched.
    attachPlayerIframe(element);
    attachPlayerIframe(element);

    expect(iframe).toBe(element);
    expect(iframe.src).toBe(loadedSrc);
    expect(getMusicEngineState()).toMatchObject({ playing: true, loaded: true, trackId: saved.id });
  });

  it("heals by reloading at the last position when the element itself is replaced", async () => {
    const saved = track("dQw4w9WgXcQ");
    playTrack(saved.id);
    await vi.waitFor(() => expect(iframe.src).not.toBe(""));
    playerMessage({ event: "onReady" });
    playerState(1, { currentTime: 64, duration: 210 });

    // Only a dev HMR reload can do this — the host is otherwise permanent.
    resetVideoHostForTests();
    iframe = mountIframe();

    await vi.waitFor(() => expect(iframe.src).toBe(wrapperUrl("dQw4w9WgXcQ", true, 64)));
  });

  it("uses the session video host as the player, and marks it active while loaded", async () => {
    const saved = track("dQw4w9WgXcQ");
    playTrack(saved.id);
    await vi.waitFor(() => expect(iframe.src).not.toBe(""));

    expect(getVideoPlayerElement()).toBe(iframe);
    expect(isVideoHostActive()).toBe(true);

    stopPlayback();
    expect(isVideoHostActive()).toBe(false);
  });
});

describe("advance + errors", () => {
  it("auto-advances when a track ends, skipping tracks that refuse to embed", async () => {
    const first = track("dQw4w9WgXcQ");
    const blocked = track("WPni755-Krg");
    const third = track("M7lc1UVf-VE");

    playTrack(first.id);
    await vi.waitFor(() => expect(iframe.src).toContain("dQw4w9WgXcQ"));
    playerMessage({ event: "onReady" });
    playerState(1, { currentTime: 1, duration: 10 });

    playerState(0); // ended → next
    await vi.waitFor(() => expect(iframe.src).toContain("WPni755-Krg"));
    expect(getMusicEngineState().trackId).toBe(blocked.id);

    playerMessage({ event: "onError", info: "150" }); // embed disallowed → mark + skip
    await vi.waitFor(() => expect(iframe.src).toContain("M7lc1UVf-VE"));
    expect(getMusicEngineState().erroredIds.has(blocked.id)).toBe(true);
    expect(getMusicEngineState().trackId).toBe(third.id);

    playerState(0); // ended → wraps past the errored one back to the first
    await vi.waitFor(() => expect(getMusicEngineState().trackId).toBe(first.id));
  });

  it("treats a build-level player error as an environment failure and stops", async () => {
    const saved = track("dQw4w9WgXcQ");
    playTrack(saved.id);
    await vi.waitFor(() => expect(iframe.src).not.toBe(""));
    playerMessage({ event: "onError", info: "153" });

    const state = getMusicEngineState();
    expect(state.playing).toBe(false);
    expect(state.environmentFailure?.kind).toBe("player-config");
    expect(state.erroredIds.has(saved.id)).toBe(false);
  });

  it("wraps next/prev around the tracklist", async () => {
    const first = track("dQw4w9WgXcQ");
    const second = track("WPni755-Krg");
    playTrack(first.id);
    await vi.waitFor(() => expect(iframe.src).toContain("dQw4w9WgXcQ"));

    next();
    await vi.waitFor(() => expect(getMusicEngineState().trackId).toBe(second.id));
    next();
    await vi.waitFor(() => expect(getMusicEngineState().trackId).toBe(first.id));
    prev();
    await vi.waitFor(() => expect(getMusicEngineState().trackId).toBe(second.id));
  });

  it("advances when the playing track is deleted, and clears when the list empties", async () => {
    const first = track("dQw4w9WgXcQ");
    const second = track("WPni755-Krg");
    playTrack(first.id);
    await vi.waitFor(() => expect(iframe.src).toContain("dQw4w9WgXcQ"));

    // The tracklist store removes it; the engine is told which id left.
    resetMusicTracklistStoreForTests({ keepStorage: true });
    track("WPni755-Krg");
    handleTrackRemoved(first.id);
    await vi.waitFor(() => expect(getMusicEngineState().trackId).toBe(second.id));

    resetMusicTracklistStoreForTests();
    handleTrackRemoved(second.id);
    expect(getMusicEngineState()).toMatchObject({ trackId: null, loaded: false, playing: false });
  });
});

describe("resume across app restarts", () => {
  it("persists the position and volume while playing", async () => {
    const saved = track("dQw4w9WgXcQ");
    playTrack(saved.id);
    await vi.waitFor(() => expect(iframe.src).not.toBe(""));
    playerMessage({ event: "onReady" });
    playerState(1, { currentTime: 96, duration: 210 });
    setVolume(41);
    togglePlay(); // pause flushes the record

    expect(JSON.parse(localStorage.getItem("canvas-music-playback-v1")!)).toEqual({
      trackId: saved.id,
      positionSec: 96,
      volume: 41,
    });
  });

  it("restores the selection paused, with no player and no request, then resumes on play", async () => {
    localStorage.setItem(
      "canvas-music-playback-v1",
      JSON.stringify({ trackId: "track-dQw4w9WgXcQ", positionSec: 137, volume: 33 }),
    );
    resetMusicEngineForTests({ keepStorage: true });
    const saved = track("dQw4w9WgXcQ");
    iframe = mountIframe();

    // Cold boot: the track is selected at its stored position, but nothing is loaded —
    // no iframe src, no YouTube request, and above all no autoplay.
    expect(getMusicEngineState()).toMatchObject({
      trackId: saved.id,
      loaded: false,
      playing: false,
      currentTime: 137,
      volume: 33,
    });
    expect(iframe.src).toBe("");
    expect(musicYoutubePlayerUrl).not.toHaveBeenCalled();

    togglePlay();
    await vi.waitFor(() => expect(iframe.src).toBe(wrapperUrl("dQw4w9WgXcQ", true, 137)));
  });

  it("drops a stored track id the tracklist no longer has", () => {
    localStorage.setItem(
      "canvas-music-playback-v1",
      JSON.stringify({ trackId: "deleted-track", positionSec: 12, volume: 60 }),
    );
    resetMusicEngineForTests({ keepStorage: true });
    track("dQw4w9WgXcQ");

    expect(getMusicEngineState()).toMatchObject({ trackId: null, currentTime: 0, volume: 60 });
  });

  it("adopts a legacy per-node volume only when this session has no record of its own", () => {
    adoptLegacyNodeVolume(25);
    expect(getMusicEngineState().volume).toBe(25);
    adoptLegacyNodeVolume(90);
    expect(getMusicEngineState().volume).toBe(25);
  });
});

describe("ducking under a voice", () => {
  async function playing() {
    const saved = track("dQw4w9WgXcQ");
    playTrack(saved.id);
    await vi.waitFor(() => expect(iframe.src).not.toBe(""));
    resyncPostMessageSpy();
    playerMessage({ event: "onReady" });
    playerState(1, { currentTime: 5, duration: 210 });
    setVolume(80);
    return saved;
  }

  function lastVolumeArg(): number | undefined {
    const volumes = sentPayloads().filter((payload) => payload.func === "setVolume");
    return (volumes.at(-1)?.args as number[] | undefined)?.[0];
  }

  it("drops the player's volume while a voice speaks, then restores it", async () => {
    await playing();
    expect(lastVolumeArg()).toBe(80);

    const release = duckMusic();
    expect(getMusicEngineState().ducked).toBe(true);
    expect(lastVolumeArg()).toBe(Math.round(80 * MUSIC_DUCK_RATIO));
    // The user's own volume is untouched — this is a duck, not a volume change.
    expect(getMusicEngineState().volume).toBe(80);

    release();
    expect(getMusicEngineState().ducked).toBe(false);
    expect(lastVolumeArg()).toBe(80);
  });

  it("holds the duck until the last speaker releases, and ignores a double release", async () => {
    await playing();
    const agent = duckMusic();
    const narration = duckMusic();

    agent();
    expect(getMusicEngineState().ducked).toBe(true);
    agent(); // releasing twice must not cancel the other speaker's claim
    expect(getMusicEngineState().ducked).toBe(true);

    narration();
    expect(getMusicEngineState().ducked).toBe(false);
    expect(lastVolumeArg()).toBe(80);
  });

  it("keeps a volume change made mid-duck, at ducked level until the voice stops", async () => {
    await playing();
    const release = duckMusic();

    setVolume(50);
    expect(lastVolumeArg()).toBe(Math.round(50 * MUSIC_DUCK_RATIO));
    expect(getMusicEngineState().volume).toBe(50);

    release();
    expect(lastVolumeArg()).toBe(50);
  });
});

describe("stopPlayback", () => {
  it("drops the player but keeps the selection and position for the next play", async () => {
    const saved = track("dQw4w9WgXcQ");
    playTrack(saved.id);
    await vi.waitFor(() => expect(iframe.src).not.toBe(""));
    playerMessage({ event: "onReady" });
    playerState(1, { currentTime: 51, duration: 210 });

    stopPlayback();
    expect(iframe.getAttribute("src")).toBeNull();
    expect(getMusicEngineState()).toMatchObject({
      trackId: saved.id,
      loaded: false,
      playing: false,
      currentTime: 51,
    });

    togglePlay();
    await vi.waitFor(() => expect(iframe.src).toBe(wrapperUrl("dQw4w9WgXcQ", true, 51)));
  });
});
