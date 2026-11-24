import { describe, expect, it, vi } from "vitest";
import { createJumpLabelsStore } from "../jump-labels-store";

describe("jumpLabelsStore", () => {
  it("starts closed", () => {
    expect(createJumpLabelsStore().snapshot()).toBeNull();
  });

  it("opens with a label per cell", () => {
    const store = createJumpLabelsStore();

    store.open(["a1", "a2"]);

    expect(store.snapshot()?.labels.size).toBe(2);
    expect(store.snapshot()?.typed).toBe("");
  });

  it("refuses to open on an empty board", () => {
    // Badges over nothing, waiting for a letter that can never match.
    const store = createJumpLabelsStore();

    store.open([]);

    expect(store.snapshot()).toBeNull();
  });

  it("closes on a hit and reports which cell", () => {
    const store = createJumpLabelsStore();
    store.open(["a1", "a2"]);

    expect(store.typeKey("s")).toEqual({ kind: "hit", nodeId: "a2" });
    expect(store.snapshot()).toBeNull();
  });

  it("stays open and remembers the typing while a label is still possible", () => {
    const store = createJumpLabelsStore();
    store.open(Array.from({ length: 20 }, (_, i) => `n${i}`));

    expect(store.typeKey("a")).toEqual({ kind: "pending" });
    expect(store.snapshot()?.typed).toBe("a");
  });

  it("completes a two-letter label across two presses", () => {
    const store = createJumpLabelsStore();
    const ids = Array.from({ length: 20 }, (_, i) => `n${i}`);
    store.open(ids);

    store.typeKey("a");

    expect(store.typeKey("s")).toEqual({ kind: "hit", nodeId: "n1" });
  });

  it("closes on a miss instead of waiting for a correction", () => {
    // A wrong key means the operator was not aiming at a badge. Staying open would swallow the next
    // keystroke too, and every one after it, until they found Escape.
    const store = createJumpLabelsStore();
    store.open(["a1", "a2"]);

    expect(store.typeKey("q")).toEqual({ kind: "miss" });
    expect(store.snapshot()).toBeNull();
  });

  it("ignores a keystroke when it is closed", () => {
    const store = createJumpLabelsStore();

    expect(store.typeKey("a")).toEqual({ kind: "miss" });
  });

  it("cancels idempotently, because Escape fires for many reasons", () => {
    const store = createJumpLabelsStore();
    store.open(["a1"]);

    store.cancel();
    store.cancel();

    expect(store.snapshot()).toBeNull();
  });

  it("re-opening starts the typing over", () => {
    const store = createJumpLabelsStore();
    store.open(Array.from({ length: 20 }, (_, i) => `n${i}`));
    store.typeKey("a");

    store.open(["a1", "a2"]);

    expect(store.snapshot()?.typed).toBe("");
  });

  it("notifies on every observable change", () => {
    const store = createJumpLabelsStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.open(["a1", "a2"]);
    store.typeKey("q");

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stays silent on a cancel that changed nothing", () => {
    // Every badge on the board re-renders on a change; a stray Escape must not repaint them.
    const store = createJumpLabelsStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.cancel();

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const store = createJumpLabelsStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);

    off();
    store.open(["a1"]);

    expect(listener).not.toHaveBeenCalled();
  });

  it("exposes a version for useSyncExternalStore", () => {
    // The snapshot is a fresh object each call, so it can never be compared by reference.
    const store = createJumpLabelsStore();
    const start = store.version();

    store.open(["a1"]);

    expect(store.version()).toBeGreaterThan(start);
  });
});
