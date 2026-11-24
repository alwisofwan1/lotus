import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RAIL_ENTER_MS, RAIL_LEAVE_MS, railMotionProps, useRailPresence } from "@/modules/workspace-shell/hooks/useRailPresence";

describe("useRailPresence", () => {
  afterEach(() => vi.useRealTimers());

  it("does not slide the launch rail in", () => {
    expect(renderHook(() => useRailPresence(true)).result.current).toBe("shown");
    expect(renderHook(() => useRailPresence(false)).result.current).toBeNull();
  });

  it("keeps the rail mounted while it leaves, then unmounts it", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ visible }) => useRailPresence(visible), { initialProps: { visible: true } });
    rerender({ visible: false });
    expect(result.current).toBe("leaving");
    act(() => vi.advanceTimersByTime(RAIL_LEAVE_MS));
    expect(result.current).toBeNull();
    rerender({ visible: true });
    expect(result.current).toBe("entering");
    act(() => vi.advanceTimersByTime(RAIL_ENTER_MS));
    expect(result.current).toBe("shown");
  });

  it("turns a leave back into an enter without unmounting", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ visible }) => useRailPresence(visible), { initialProps: { visible: true } });
    rerender({ visible: false });
    rerender({ visible: true });
    act(() => vi.advanceTimersByTime(RAIL_LEAVE_MS));
    expect(result.current).toBe("entering");
  });

  it("hands the body the rail width only while it moves", () => {
    expect(railMotionProps("entering", 260)).toEqual({ "data-rail-motion": "entering", style: { "--ws-rail-w": "260px" } });
    expect(railMotionProps("shown", 260)).toEqual({ "data-rail-motion": undefined, style: undefined });
  });
});
