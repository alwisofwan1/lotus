import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MusicTracklist } from "../MusicTracklist";
import { MusicPasteBar } from "../MusicPasteBar";
import { formatPlaybackTime } from "../MusicTransport";
import type { MusicTrack } from "../../../services/music/music-track";

const tracks: MusicTrack[] = [
  { id: "a", videoId: "AAAAAAAAAAA", url: "https://youtu.be/AAAAAAAAAAA", title: "Hyperfocus Techno", author: "Mind Amend", thumbnailUrl: "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg", durationSec: 10800, addedAt: 1 },
  { id: "b", videoId: "BBBBBBBBBBB", url: "https://youtu.be/BBBBBBBBBBB", title: "Lofi Beats", author: "Lofi Girl", thumbnailUrl: "https://i.ytimg.com/vi/BBBBBBBBBBB/hqdefault.jpg", addedAt: 2 },
];

function renderList(overrides: Partial<Parameters<typeof MusicTracklist>[0]> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onMove: vi.fn(),
  };
  render(
    <MusicTracklist
      tracks={tracks}
      activeTrackId="a"
      playing={false}
      erroredIds={new Set<string>()}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("MusicTracklist", () => {
  it("plays a track on row click", () => {
    const h = renderList();
    fireEvent.click(screen.getByText("Lofi Beats"));
    expect(h.onSelect).toHaveBeenCalledWith("b");
  });

  it("deletes a track via the trash action without selecting it", () => {
    const h = renderList();
    fireEvent.click(screen.getAllByLabelText("Delete track")[1]);
    expect(h.onDelete).toHaveBeenCalledWith("b");
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it("renames inline via double-click, committing on Enter", () => {
    const h = renderList();
    fireEvent.doubleClick(screen.getByText("Hyperfocus Techno"));
    const input = screen.getByRole("textbox", { name: "Rename track" });
    fireEvent.change(input, { target: { value: "Deep Work Mix" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onRename).toHaveBeenCalledWith("a", "Deep Work Mix");
  });

  it("badges embed-disallowed tracks instead of showing a duration", () => {
    renderList({ erroredIds: new Set(["b"]) });
    expect(screen.getByText("NO EMBED")).toBeTruthy();
  });
});

describe("MusicPasteBar", () => {
  it("submits on Enter and clears the input on success", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<MusicPasteBar onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Paste a YouTube link");
    fireEvent.change(input, { target: { value: "https://youtu.be/AAAAAAAAAAA" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("https://youtu.be/AAAAAAAAAAA");
    await vi.waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("shows the rejection message inline and keeps the input", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Not a valid YouTube link — try a watch / youtu.be / shorts URL."));
    render(<MusicPasteBar onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Paste a YouTube link");
    fireEvent.change(input, { target: { value: "spotify.com/track/x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Not a valid YouTube link");
    expect((input as HTMLInputElement).value).toBe("spotify.com/track/x");
  });
});

describe("formatPlaybackTime", () => {
  it("formats playback time with clock-style hours for long mixes", () => {
    expect(formatPlaybackTime(10800)).toBe("3:00:00");
    expect(formatPlaybackTime(13207)).toBe("3:40:07");
    expect(formatPlaybackTime(754)).toBe("12:34");
    expect(formatPlaybackTime(0)).toBe("0:00");
    expect(formatPlaybackTime(Number.NaN)).toBe("0:00");
  });
});
