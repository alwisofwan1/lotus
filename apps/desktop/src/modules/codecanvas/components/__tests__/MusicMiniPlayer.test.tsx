import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicMiniPlayer } from "../MusicMiniPlayer";
import { createMusicTrack, type MusicTrack } from "../../services/music/music-track";
import { addTrack, resetMusicTracklistStoreForTests } from "../../services/music/music-tracklist-store";
import {
  getMusicEngineState,
  playTrack,
  resetMusicEngineForTests,
} from "../../services/music/music-engine";
import {
  VIDEO_HOST_ID,
  flushVideoHostLayoutForTests,
  getVideoSlotOwner,
  registerVideoSlot,
  resetVideoHostForTests,
} from "../../services/music/music-video-host";
import { musicYoutubePlayerUrl } from "@/lib/tauri-api";

vi.mock("@/lib/tauri-api", () => ({
  isTauri: vi.fn(() => true),
  musicResolveTrack: vi.fn(),
  musicYoutubePlayerUrl: vi.fn(),
}));

const WRAPPER_URL = "http://127.0.0.1:9877/api/music/youtube-player?videoId=dQw4w9WgXcQ&autoplay=true";

function seedTrack(): MusicTrack {
  return addTrack(
    createMusicTrack({
      id: "track-1",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      videoId: "dQw4w9WgXcQ",
      meta: { title: "Deep Focus Mix", author: "Lotus Test", thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg" },
      addedAt: 1,
    }),
  );
}

/** jsdom has no layout: give the dock's slot a real box so the host can take it. */
function stubSlotBox(element: Element, box = { left: 1200, top: 700, width: 96, height: 54 }) {
  element.getBoundingClientRect = () => ({
    ...box,
    right: box.left + box.width,
    bottom: box.top + box.height,
    x: box.left,
    y: box.top,
    toJSON: () => ({}),
  }) as DOMRect;
}

beforeEach(() => {
  localStorage.clear();
  resetMusicTracklistStoreForTests();
  resetMusicEngineForTests();
  resetVideoHostForTests();
  window.innerWidth = 1440;
  window.innerHeight = 900;
  vi.mocked(musicYoutubePlayerUrl).mockReset();
  vi.mocked(musicYoutubePlayerUrl).mockResolvedValue(WRAPPER_URL);
});

afterEach(() => {
  resetVideoHostForTests();
});

describe("MusicMiniPlayer", () => {
  it("stays out of the way until a player exists", () => {
    seedTrack();
    const { container } = render(<MusicMiniPlayer />);
    expect(container.firstChild).toBeNull();
  });

  it("rests as a pill with no video, and takes the video only once expanded", async () => {
    const saved = seedTrack();
    render(<MusicMiniPlayer />);
    playTrack(saved.id);

    const player = await screen.findByLabelText("Music mini player");
    // No iframe in here: nothing audible lives in this component, which is why it is
    // free to unmount when a canvas node claims the video.
    expect(player.querySelector("iframe")).toBeNull();

    // At rest it offers no slot at all, so the host parks off-screen — audio only.
    expect(player).toHaveAttribute("data-expanded", "false");
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBeNull();
    expect(getMusicEngineState().loaded).toBe(true);

    const slot = player.querySelector(".lotus-mini-player-media") as HTMLElement;
    stubSlotBox(slot);
    await userEvent.hover(player);

    await waitFor(() => expect(player).toHaveAttribute("data-expanded", "true"));
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBe("dock");
    expect(document.getElementById(VIDEO_HOST_ID)?.querySelector("iframe")).not.toBeNull();

    await userEvent.unhover(player);
    await waitFor(() => expect(player).toHaveAttribute("data-expanded", "false"));
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBeNull();
    expect(getMusicEngineState().loaded).toBe(true);
  });

  it("keeps clear of the window controls it is told about", async () => {
    const saved = seedTrack();
    render(<MusicMiniPlayer rightOffsetPx={150} />);
    playTrack(saved.id);

    // The strip lives in the top-right chrome band, which on Windows/Linux is where
    // minimise/maximise/close sit — the shell passes the inset it must clear.
    const player = await screen.findByLabelText("Music mini player");
    expect(player.style.right).toBe("150px");
  });

  it("expands on keyboard focus so prev/next are reachable without a pointer", async () => {
    const saved = seedTrack();
    render(<MusicMiniPlayer />);
    playTrack(saved.id);
    const player = await screen.findByLabelText("Music mini player");

    await userEvent.tab();
    await waitFor(() => expect(player).toHaveAttribute("data-expanded", "true"));
    expect(screen.getByRole("button", { name: "Next track" })).toBeInTheDocument();
  });

  it("hides itself while a canvas music node holds the video", async () => {
    const saved = seedTrack();
    render(<MusicMiniPlayer />);
    playTrack(saved.id);
    await screen.findByLabelText("Music mini player");

    // A node mounts elsewhere and wins the slot (higher priority).
    const nodeSlot = document.createElement("div");
    document.body.appendChild(nodeSlot);
    stubSlotBox(nodeSlot, { left: 100, top: 100, width: 400, height: 220 });
    const releaseNode = registerVideoSlot(nodeSlot, { kind: "node" });
    flushVideoHostLayoutForTests();

    await waitFor(() => expect(screen.queryByLabelText("Music mini player")).toBeNull());
    // Audio is untouched by the dock unmounting.
    expect(getMusicEngineState().loaded).toBe(true);

    releaseNode();
    flushVideoHostLayoutForTests();
    await screen.findByLabelText("Music mini player");
  });

  it("closing tears the player down but keeps the place in the track", async () => {
    const saved = seedTrack();
    render(<MusicMiniPlayer />);
    playTrack(saved.id);
    await screen.findByLabelText("Music mini player");

    await userEvent.click(screen.getByRole("button", { name: "Close player" }));

    expect(screen.queryByLabelText("Music mini player")).toBeNull();
    expect(getMusicEngineState()).toMatchObject({ trackId: saved.id, loaded: false, playing: false });
  });
});
