import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "./music-track";
import {
  addTrack,
  getTracks,
  moveTrack,
  nextTrackId,
  patchTrack,
  prevTrackId,
  removeTrack,
  renameTrack,
  resetMusicTracklistStoreForTests,
  subscribeTracklist,
} from "./music-tracklist-store";

function track(overrides: Partial<MusicTrack> & { id: string; videoId: string }): MusicTrack {
  return {
    url: `https://youtu.be/${overrides.videoId}`,
    title: `Title ${overrides.id}`,
    author: "Author",
    thumbnailUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg",
    addedAt: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetMusicTracklistStoreForTests();
});

describe("music tracklist store", () => {
  it("adds a track and lists it", () => {
    const added = addTrack(track({ id: "a", videoId: "AAAAAAAAAAA" }));
    expect(added.id).toBe("a");
    expect(getTracks()).toHaveLength(1);
    expect(getTracks()[0].videoId).toBe("AAAAAAAAAAA");
  });

  it("re-adding the same video returns the existing track instead of duplicating", () => {
    addTrack(track({ id: "a", videoId: "AAAAAAAAAAA" }));
    const again = addTrack(track({ id: "b", videoId: "AAAAAAAAAAA" }));
    expect(again.id).toBe("a");
    expect(getTracks()).toHaveLength(1);
  });

  it("removes a track by id", () => {
    addTrack(track({ id: "a", videoId: "AAAAAAAAAAA" }));
    addTrack(track({ id: "b", videoId: "BBBBBBBBBBB" }));
    removeTrack("a");
    expect(getTracks().map((t) => t.id)).toEqual(["b"]);
  });

  it("renames a track, trimming and ignoring empty titles", () => {
    addTrack(track({ id: "a", videoId: "AAAAAAAAAAA" }));
    renameTrack("a", "  My Focus Mix  ");
    expect(getTracks()[0].title).toBe("My Focus Mix");
    renameTrack("a", "   ");
    expect(getTracks()[0].title).toBe("My Focus Mix");
  });

  it("backfills duration via patchTrack", () => {
    addTrack(track({ id: "a", videoId: "AAAAAAAAAAA" }));
    patchTrack("a", { durationSec: 10_800 });
    expect(getTracks()[0].durationSec).toBe(10_800);
  });

  it("reorders with moveTrack, clamping the target index", () => {
    addTrack(track({ id: "a", videoId: "AAAAAAAAAAA" }));
    addTrack(track({ id: "b", videoId: "BBBBBBBBBBB" }));
    addTrack(track({ id: "c", videoId: "CCCCCCCCCCC" }));
    moveTrack("c", 0);
    expect(getTracks().map((t) => t.id)).toEqual(["c", "a", "b"]);
    moveTrack("c", 99);
    expect(getTracks().map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("steps to next/prev with wrap-around (auto-advance + transport)", () => {
    addTrack(track({ id: "a", videoId: "AAAAAAAAAAA" }));
    addTrack(track({ id: "b", videoId: "BBBBBBBBBBB" }));
    addTrack(track({ id: "c", videoId: "CCCCCCCCCCC" }));
    expect(nextTrackId("a")).toBe("b");
    expect(nextTrackId("c")).toBe("a");
    expect(prevTrackId("a")).toBe("c");
    expect(nextTrackId("missing")).toBe("a"); // deleted active track → start of list
  });

  it("returns null navigation on an empty tracklist", () => {
    expect(nextTrackId("a")).toBeNull();
    expect(prevTrackId("a")).toBeNull();
  });

  it("notifies subscribers on every mutation", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTracklist(listener);
    addTrack(track({ id: "a", videoId: "AAAAAAAAAAA" }));
    renameTrack("a", "Renamed");
    removeTrack("a");
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    addTrack(track({ id: "b", videoId: "BBBBBBBBBBB" }));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("persists to localStorage and hydrates a fresh store", () => {
    addTrack(track({ id: "a", videoId: "AAAAAAAAAAA" }));
    renameTrack("a", "Persisted Mix");
    resetMusicTracklistStoreForTests({ keepStorage: true });
    expect(getTracks().map((t) => t.title)).toEqual(["Persisted Mix"]);
  });

  it("falls back to an empty tracklist on corrupt storage", () => {
    localStorage.setItem("canvas-music-tracklist-v1", "{not json");
    expect(getTracks()).toEqual([]);
    localStorage.setItem("canvas-music-tracklist-v1", JSON.stringify({ nope: true }));
    resetMusicTracklistStoreForTests({ keepStorage: true });
    expect(getTracks()).toEqual([]);
  });
});
