import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasFrameOverviewStore } from "../canvas-frame-overview-store";

afterEach(() => canvasFrameOverviewStore.close());

describe("canvasFrameOverviewStore.setLabels (decision 42)", () => {
  it("replaces the labels while open and notifies once", () => {
    canvasFrameOverviewStore.open({ a: { text: "01 · 1 node", needsYou: false } }, "a");
    const fn = vi.fn();
    const off = canvasFrameOverviewStore.subscribe(fn);
    canvasFrameOverviewStore.setLabels({ a: { text: "01 · 2 nodes", needsYou: false } });
    expect(canvasFrameOverviewStore.get().labels.a.text).toBe("01 · 2 nodes");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it("does not notify when nothing changed", () => {
    canvasFrameOverviewStore.open({ a: { text: "01 · 1 node", needsYou: false } }, "a");
    const fn = vi.fn();
    const off = canvasFrameOverviewStore.subscribe(fn);
    canvasFrameOverviewStore.setLabels({ a: { text: "01 · 1 node", needsYou: false } });
    expect(fn).not.toHaveBeenCalled();
    off();
  });

  it("is ignored while the Overview is closed", () => {
    canvasFrameOverviewStore.setLabels({ a: { text: "x", needsYou: false } });
    expect(canvasFrameOverviewStore.get().labels).toEqual({});
  });
});

describe("canvasFrameOverviewStore.fullDetail (decision 44)", () => {
  it("carries the live-content flag while open and clears it on close", () => {
    canvasFrameOverviewStore.open({}, null, true);
    expect(canvasFrameOverviewStore.get().fullDetail).toBe(true);
    canvasFrameOverviewStore.setFullDetail(false);
    expect(canvasFrameOverviewStore.get().fullDetail).toBe(false);
    canvasFrameOverviewStore.setFullDetail(true);
    canvasFrameOverviewStore.close();
    expect(canvasFrameOverviewStore.get().fullDetail).toBe(false);
  });

  it("ignores setFullDetail when closed", () => {
    canvasFrameOverviewStore.setFullDetail(true);
    expect(canvasFrameOverviewStore.get().fullDetail).toBe(false);
  });
});
