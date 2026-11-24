import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyYouTubePlayerError,
  probeYouTubeIframePlayback,
  resetYouTubePlaybackProbeCacheForTests,
  resolveYouTubeEmbedOrigin,
} from "./youtube-playback-health";

afterEach(() => {
  resetYouTubePlaybackProbeCacheForTests();
  vi.useRealTimers();
});

describe("resolveYouTubeEmbedOrigin", () => {
  it("keeps http and https origins for YouTube JSAPI", () => {
    expect(resolveYouTubeEmbedOrigin({ origin: "http://localhost:3001", protocol: "http:" })).toBe("http://localhost:3001");
    expect(resolveYouTubeEmbedOrigin({ origin: "https://lotus.example", protocol: "https:" })).toBe("https://lotus.example");
  });

  it("drops custom or opaque origins so release builds can fall back by probe", () => {
    expect(resolveYouTubeEmbedOrigin({ origin: "tauri://localhost", protocol: "tauri:" })).toBeUndefined();
    expect(resolveYouTubeEmbedOrigin({ origin: "null", protocol: "file:" })).toBeUndefined();
  });
});

describe("classifyYouTubePlayerError", () => {
  it("treats 101 and 150 as video-scoped embed restrictions", () => {
    expect(classifyYouTubePlayerError(150)).toMatchObject({
      kind: "embed-disallowed",
      trackScoped: true,
      badge: "NO EMBED",
    });
  });

  it("treats 153 as environment/player configuration failure", () => {
    expect(classifyYouTubePlayerError(153)).toMatchObject({
      kind: "player-config",
      trackScoped: false,
      badge: "DESKTOP BLOCKED",
    });
  });
});

describe("probeYouTubeIframePlayback", () => {
  it("returns a cached timeout failure when the iframe never becomes ready", async () => {
    vi.useFakeTimers();
    const first = probeYouTubeIframePlayback({ timeoutMs: 20, now: () => 123 });
    await vi.advanceTimersByTimeAsync(20);
    await expect(first).resolves.toMatchObject({
      ok: false,
      checkedAt: 123,
      failure: { kind: "player-unavailable", trackScoped: false, badge: "PLAYER TIMEOUT" },
    });

    const second = await probeYouTubeIframePlayback({ timeoutMs: 20, now: () => 999 });
    expect(second).toMatchObject({ ok: false, checkedAt: 123 });
  });
});
