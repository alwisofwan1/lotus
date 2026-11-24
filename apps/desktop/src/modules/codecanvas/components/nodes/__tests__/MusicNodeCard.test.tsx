import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MusicNodeCard } from "../MusicNodeCard";
import type { MusicTrack } from "../../../services/music/music-track";
import { addTrack, getTracks, resetMusicTracklistStoreForTests } from "../../../services/music/music-tracklist-store";
import {
  getMusicEngineState,
  resetMusicEngineForTests,
} from "../../../services/music/music-engine";
import {
  ensureVideoHost,
  flushVideoHostLayoutForTests,
  getVideoSlotOwner,
  resetVideoHostForTests,
  setVideoHostActive,
} from "../../../services/music/music-video-host";
import { musicYoutubePlayerUrl } from "@/lib/tauri-api";

vi.mock("@/lib/tauri-api", () => ({
  isTauri: vi.fn(() => true),
  musicResolveTrack: vi.fn(),
  musicYoutubePlayerUrl: vi.fn(),
}));

function track(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: "track-1",
    videoId: "dQw4w9WgXcQ",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Embeddable Track",
    author: "Lotus Test",
    thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    addedAt: 1,
    ...overrides,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof MusicNodeCard>> = {}) {
  return render(
    <MusicNodeCard
      activeTrackId={props.activeTrackId}
      volume={props.volume}
      onPatch={props.onPatch ?? vi.fn()}
      onClose={props.onClose ?? vi.fn()}
    />,
  );
}

/** jsdom has no layout: state the slot's box so the video host can take it. */
function stubSlotBox(element: Element, box = { left: 120, top: 90, width: 400, height: 220 }) {
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
  vi.mocked(musicYoutubePlayerUrl).mockResolvedValue(
    "http://127.0.0.1:9877/api/music/youtube-player?videoId=dQw4w9WgXcQ&autoplay=true",
  );
});

describe("MusicNodeCard", () => {
  it("shows the thumbnail as artwork and hosts no player of its own", async () => {
    const saved = addTrack(track());
    const { container } = renderCard({ activeTrackId: saved.id });

    await screen.findByTitle(`${saved.title} — ${saved.author}`);
    expect(container.querySelector("img")).toHaveAttribute("src", saved.thumbnailUrl);
    // The player element belongs to the session video host, never to this subtree —
    // a node-owned iframe is exactly what used to die on every project switch.
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("offers its artwork box to the video host, and gives it up on unmount", async () => {
    const saved = addTrack(track());
    const { container, unmount } = renderCard({ activeTrackId: saved.id });
    await screen.findByTitle(`${saved.title} — ${saved.author}`);

    const slot = container.querySelector(".canvas-music-media-slot") as HTMLElement;
    expect(slot).not.toBeNull();
    stubSlotBox(slot);

    // A live player is what makes the host take a slot at all (production reaches
    // this state through the engine's load()).
    ensureVideoHost();
    setVideoHostActive(true);
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBe("node");

    // The project switch: this node unmounts, and the video moves on rather than dying.
    unmount();
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBeNull();
  });

  it("restores its persisted track into the engine when nothing is selected yet", async () => {
    const first = addTrack(track());
    addTrack(track({ id: "track-2", videoId: "WPni755-Krg", title: "Second" }));

    renderCard({ activeTrackId: first.id });

    await waitFor(() => expect(getMusicEngineState().trackId).toBe(first.id));
    // Restoring must not start playback or build a player.
    expect(getMusicEngineState().loaded).toBe(false);
    expect(musicYoutubePlayerUrl).not.toHaveBeenCalled();
  });

  it("delegates play to the engine, resuming at the restored position", async () => {
    const saved = addTrack(track());
    localStorage.setItem(
      "canvas-music-playback-v1",
      JSON.stringify({ trackId: saved.id, positionSec: 88, volume: 70 }),
    );
    resetMusicEngineForTests({ keepStorage: true });

    renderCard({ activeTrackId: saved.id });
    await userEvent.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() =>
      expect(musicYoutubePlayerUrl).toHaveBeenCalledWith(saved.videoId, true, 88),
    );
    expect(getMusicEngineState().loaded).toBe(true);
  });

  it("mirrors the engine's selection back into the canvas snapshot", async () => {
    const first = addTrack(track());
    const second = addTrack(track({ id: "track-2", videoId: "WPni755-Krg", title: "Second" }));
    const onPatch = vi.fn();

    renderCard({ activeTrackId: first.id, onPatch });
    await waitFor(() => expect(getMusicEngineState().trackId).toBe(first.id));

    await userEvent.click(screen.getByText(second.title));
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ activeTrackId: second.id }));
  });

  it("adopts the legacy per-node volume once, then keeps the engine's own", async () => {
    addTrack(track());
    renderCard({ activeTrackId: "track-1", volume: 35 });

    await waitFor(() => expect(getMusicEngineState().volume).toBe(35));
  });

  it("advances past a deleted track instead of leaving the node empty", async () => {
    const first = addTrack(track());
    const second = addTrack(track({ id: "track-2", videoId: "WPni755-Krg", title: "Second" }));
    renderCard({ activeTrackId: first.id });
    await waitFor(() => expect(getMusicEngineState().trackId).toBe(first.id));

    const rows = screen.getAllByRole("listitem");
    await userEvent.click(rows[0].querySelector(".canvas-music-row-remove") as HTMLElement);

    await waitFor(() => expect(getMusicEngineState().trackId).toBe(second.id));
    expect(getTracks().map((t) => t.id)).toEqual([second.id]);
  });
});
