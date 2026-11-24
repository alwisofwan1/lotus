import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCanvasBrowserActivityForTests,
  getCanvasBrowserActivity,
  setCanvasBrowserActivity,
  subscribeCanvasBrowserActivity,
} from "../canvas-browser-activity-store";

describe("canvas-browser-activity-store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetCanvasBrowserActivityForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reflects active true/false for a terminal", () => {
    expect(getCanvasBrowserActivity("t1")).toBe(false);
    setCanvasBrowserActivity("t1", true);
    expect(getCanvasBrowserActivity("t1")).toBe(true);
    setCanvasBrowserActivity("t1", false);
    expect(getCanvasBrowserActivity("t1")).toBe(false);
  });

  it("isolates activity per terminal", () => {
    setCanvasBrowserActivity("t1", true);
    expect(getCanvasBrowserActivity("t1")).toBe(true);
    expect(getCanvasBrowserActivity("t2")).toBe(false);
  });

  it("notifies subscribers on change", () => {
    const spy = vi.fn();
    const unsub = subscribeCanvasBrowserActivity(spy);
    setCanvasBrowserActivity("t1", true);
    expect(spy).toHaveBeenCalledTimes(1);
    setCanvasBrowserActivity("t1", false);
    expect(spy).toHaveBeenCalledTimes(2);
    unsub();
    setCanvasBrowserActivity("t1", true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("auto-clears via the safety timer if a trailing false is lost", () => {
    setCanvasBrowserActivity("t1", true);
    expect(getCanvasBrowserActivity("t1")).toBe(true);
    vi.advanceTimersByTime(19_999);
    expect(getCanvasBrowserActivity("t1")).toBe(true); // still on before the cap
    vi.advanceTimersByTime(2);
    expect(getCanvasBrowserActivity("t1")).toBe(false); // safety cleared
  });

  it("does not clear mid-operation: a repeated true resets the safety timer", () => {
    setCanvasBrowserActivity("t1", true);
    vi.advanceTimersByTime(15_000);
    setCanvasBrowserActivity("t1", true); // second action before the cap resets the window
    vi.advanceTimersByTime(15_000);
    expect(getCanvasBrowserActivity("t1")).toBe(true);
  });

  it("ignores a blank terminal id", () => {
    setCanvasBrowserActivity("", true);
    expect(getCanvasBrowserActivity("")).toBe(false);
  });
});
