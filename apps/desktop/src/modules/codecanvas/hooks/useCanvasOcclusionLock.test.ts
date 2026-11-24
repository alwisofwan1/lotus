import { StrictMode } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useCanvasOcclusionLock } from "./useCanvasOcclusionLock";
import {
  getCanvasOcclusionBlockedSnapshot,
  __resetCanvasOcclusionForTests,
} from "../services/canvas-occlusion-store";

afterEach(() => {
  __resetCanvasOcclusionForTests();
});

describe("useCanvasOcclusionLock", () => {
  it("holds a blocking lock while active, releases when active flips false", () => {
    const { rerender } = renderHook(({ active }) => useCanvasOcclusionLock(active, "modal"), {
      initialProps: { active: true },
    });
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(true);

    rerender({ active: false });
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(false);
  });

  it("releases the lock on unmount while still active", () => {
    const { unmount } = renderHook(() => useCanvasOcclusionLock(true, "modal"));
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(true);

    unmount();
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(false);
  });

  it("does not lock when inactive", () => {
    renderHook(() => useCanvasOcclusionLock(false));
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(false);
  });

  it("nets to a single held lock under StrictMode double-invocation", () => {
    renderHook(() => useCanvasOcclusionLock(true, "modal"), { wrapper: StrictMode });
    expect(getCanvasOcclusionBlockedSnapshot()).toBe(true);
  });
});
