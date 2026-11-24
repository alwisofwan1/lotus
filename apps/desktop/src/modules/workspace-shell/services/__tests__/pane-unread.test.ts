import { describe, expect, it, vi } from "vitest";
import { createPaneUnreadStore } from "@/modules/workspace-shell/services/pane-unread";

/**
 * "Selesai terlihat. Fokus tetap di tangan user." — a finished turn stays marked until that pane is
 * opened, and opening one pane never clears another.
 */
describe("pane unread", () => {
  it("marks a pane the user was not looking at when its turn ended", () => {
    const store = createPaneUnreadStore();
    store.finished("p1", { seen: false, at: 10 });

    expect(store.isUnread("p1")).toBe(true);
  });

  it("does not mark a pane the user was watching finish", () => {
    const store = createPaneUnreadStore();
    store.finished("p1", { seen: true, at: 10 });

    expect(store.isUnread("p1")).toBe(false);
  });

  it("clears only the pane that was opened", () => {
    const store = createPaneUnreadStore();
    store.finished("p1", { seen: false, at: 10 });
    store.finished("p2", { seen: false, at: 20 });

    store.markRead("p1");

    expect(store.isUnread("p1")).toBe(false);
    expect(store.isUnread("p2")).toBe(true);
  });

  it("lists unread panes oldest first, so the longest-waiting result is reached first", () => {
    const store = createPaneUnreadStore();
    store.finished("late", { seen: false, at: 30 });
    store.finished("early", { seen: false, at: 10 });

    expect(store.unreadIds()).toEqual(["early", "late"]);
  });

  it("keeps the first finish time when a pane finishes again before it is read", () => {
    const store = createPaneUnreadStore();
    store.finished("a", { seen: false, at: 10 });
    store.finished("b", { seen: false, at: 20 });
    store.finished("a", { seen: false, at: 30 });

    expect(store.unreadIds()).toEqual(["a", "b"]);
  });

  it("forgets panes that no longer exist", () => {
    const store = createPaneUnreadStore();
    store.finished("gone", { seen: false, at: 10 });
    store.finished("kept", { seen: false, at: 20 });

    store.retain(new Set(["kept"]));

    expect(store.unreadIds()).toEqual(["kept"]);
  });

  it("tells subscribers about a change, and stays quiet about a no-op", () => {
    const store = createPaneUnreadStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.finished("p1", { seen: false, at: 10 });
    store.markRead("p1");
    store.markRead("p1");
    store.finished("p2", { seen: true, at: 20 });
    store.retain(new Set());

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps its marks across a reload when given a storage", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
    const first = createPaneUnreadStore(storage);
    first.finished("p1", { seen: false, at: 10 });
    first.finished("p2", { seen: false, at: 20 });
    first.markRead("p2");

    const second = createPaneUnreadStore(storage);
    expect(second.unreadIds()).toEqual(["p1"]);
    expect(second.since("p1")).toBe(10);
  });

  it("starts empty from a corrupt storage instead of throwing", () => {
    const store = createPaneUnreadStore({ getItem: () => "{not json", setItem: () => {} });
    expect(store.unreadIds()).toEqual([]);
  });
});
