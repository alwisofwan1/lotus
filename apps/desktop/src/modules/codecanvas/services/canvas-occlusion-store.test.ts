import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCanvasOcclusion,
  getCanvasOcclusionBlockedSnapshot,
  subscribeCanvasOcclusion,
  registerDockedOccluder,
  getDockedOccluderRects,
  subscribeDockedOccluders,
  notifyDockedOccluders,
  __resetCanvasOcclusionForTests,
} from "./canvas-occlusion-store";

afterEach(() => {
  __resetCanvasOcclusionForTests();
});

describe("canvas occlusion store — blocking", () => {
  it("reports blocked while a blocking occlusion is held, unblocked once released", () => {
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(false);

    const release = acquireCanvasOcclusion("settings-modal");
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(true);

    release();
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(false);
  });

  it("stays blocked until every holder releases (ref-counted)", () => {
    const releaseA = acquireCanvasOcclusion("a");
    const releaseB = acquireCanvasOcclusion("b");
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(true);

    releaseA();
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(true);

    releaseB();
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(false);
  });

  it("treats a double-release as a no-op so ref-count survives StrictMode double-invoke", () => {
    const release = acquireCanvasOcclusion("a");
    acquireCanvasOcclusion("b");

    release();
    release(); // second call must not decrement the still-held "b"

    expect(getCanvasOcclusionBlockedSnapshot()).toBe(true);
  });

  it("notifies subscribers only on the blocked-state edges, not every acquire", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCanvasOcclusion(listener);

    const releaseA = acquireCanvasOcclusion("a"); // false -> true edge
    const releaseB = acquireCanvasOcclusion("b"); // no edge
    expect(listener).toHaveBeenCalledTimes(1);

    releaseA(); // still held by b, no edge
    releaseB(); // true -> false edge
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    acquireCanvasOcclusion("c");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe("canvas occlusion store — docked occluders", () => {
  it("reads registered occluder rects fresh from their providers", () => {
    expect(getDockedOccluderRects()).toEqual([]);

    let current = rect(0, 700, 1000, 760);
    const unregister = registerDockedOccluder("nl-bar", () => current);
    expect(getDockedOccluderRects()).toEqual([current]);

    // Providers are read at call time, so a moved dock is reflected without re-registering.
    current = rect(0, 680, 1000, 760);
    expect(getDockedOccluderRects()).toEqual([current]);

    unregister();
    expect(getDockedOccluderRects()).toEqual([]);
  });

  it("drops occluders whose provider returns null (unmounted ref)", () => {
    registerDockedOccluder("gone", () => null);
    registerDockedOccluder("here", () => rect(0, 0, 10, 10));
    expect(getDockedOccluderRects()).toEqual([rect(0, 0, 10, 10)]);
  });

  it("notifies docked subscribers on register, unregister, and explicit notify", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDockedOccluders(listener);

    const unregister = registerDockedOccluder("nl-bar", () => rect(0, 0, 1, 1));
    expect(listener).toHaveBeenCalledTimes(1);

    notifyDockedOccluders(); // dock geometry changed (resize/animation)
    expect(listener).toHaveBeenCalledTimes(2);

    unregister();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    registerDockedOccluder("other", () => rect(0, 0, 1, 1));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("reset clears docked occluders too", () => {
    registerDockedOccluder("nl-bar", () => rect(0, 0, 1, 1));
    __resetCanvasOcclusionForTests();
    expect(getDockedOccluderRects()).toEqual([]);
  });
});
