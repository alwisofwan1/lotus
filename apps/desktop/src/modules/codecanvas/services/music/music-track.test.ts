import { describe, expect, it } from "vitest";
import { createMusicTrack, parseYoutubeVideoId, youtubeEmbedUrl } from "./music-track";

describe("parseYoutubeVideoId", () => {
  it("extracts the video id from a standard watch URL", () => {
    expect(parseYoutubeVideoId("https://www.youtube.com/watch?v=WPni755-Krg")).toBe("WPni755-Krg");
  });

  it("extracts the id from a youtu.be short link, ignoring share params", () => {
    expect(parseYoutubeVideoId("https://youtu.be/WPni755-Krg?si=abc123&t=42")).toBe("WPni755-Krg");
  });

  it("extracts the id when v is not the first query param", () => {
    expect(parseYoutubeVideoId("https://www.youtube.com/watch?list=PLx&v=dQw4w9WgXcQ&t=10s")).toBe("dQw4w9WgXcQ");
  });

  it("supports shorts, embed, and live path shapes", () => {
    expect(parseYoutubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("supports music.youtube.com and m.youtube.com hosts", () => {
    expect(parseYoutubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD1")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("accepts a pasted link without a scheme", () => {
    expect(parseYoutubeVideoId("youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeVideoId("youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("rejects non-YouTube URLs and malformed ids", () => {
    expect(parseYoutubeVideoId("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")).toBeNull();
    expect(parseYoutubeVideoId("https://www.youtube.com/watch?v=too-short")).toBeNull();
    expect(parseYoutubeVideoId("https://www.youtube.com/feed/subscriptions")).toBeNull();
    expect(parseYoutubeVideoId("not a url at all")).toBeNull();
    expect(parseYoutubeVideoId("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});

describe("createMusicTrack", () => {
  it("builds a track from url + resolved metadata with a stable id and timestamp", () => {
    const track = createMusicTrack({
      url: "https://youtu.be/dQw4w9WgXcQ",
      videoId: "dQw4w9WgXcQ",
      meta: { title: "Never Gonna Give You Up", author: "Rick Astley", thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" },
      id: "track-1",
      addedAt: 1_000,
    });
    expect(track).toEqual({
      id: "track-1",
      videoId: "dQw4w9WgXcQ",
      url: "https://youtu.be/dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      author: "Rick Astley",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      addedAt: 1_000,
    });
  });
});

describe("youtubeEmbedUrl", () => {
  it("builds a JSAPI-enabled embed URL for the video", () => {
    const url = new URL(youtubeEmbedUrl("dQw4w9WgXcQ", { origin: "http://localhost:3001" }));
    expect(url.origin + url.pathname).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(url.searchParams.get("enablejsapi")).toBe("1");
    expect(url.searchParams.get("playsinline")).toBe("1");
    expect(url.searchParams.get("autoplay")).toBe("0");
    expect(url.searchParams.get("origin")).toBe("http://localhost:3001");
  });

  it("turns on autoplay when requested", () => {
    const url = new URL(youtubeEmbedUrl("dQw4w9WgXcQ", { autoplay: true }));
    expect(url.searchParams.get("autoplay")).toBe("1");
  });

  it("omits unusable custom-scheme origins so the playback probe can fall back cleanly", () => {
    const url = new URL(youtubeEmbedUrl("dQw4w9WgXcQ", { origin: "tauri://localhost" }));
    expect(url.searchParams.has("origin")).toBe(false);
  });
});
