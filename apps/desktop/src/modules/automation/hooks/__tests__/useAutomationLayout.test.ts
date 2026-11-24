import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTOMATION_LAYOUT_KEY, readStoredWidths, useAutomationLayout } from "../useAutomationLayout";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("useAutomationLayout", () => {
  it("keeps a host's widths with the host", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useAutomationLayout({ automationNavWidth: 250, automationPaneWidth: 500 }, onChange));
    expect(result.current[0]).toEqual({ automationNavWidth: 250, automationPaneWidth: 500 });
    act(() => result.current[1]({ automationNavWidth: 260 }));
    expect(onChange).toHaveBeenCalledWith({ automationNavWidth: 260 });
    expect(localStorage.getItem(AUTOMATION_LAYOUT_KEY)).toBeNull();
  });

  it("keeps its own widths in storage when the host has none, and reads them back", () => {
    const { result } = renderHook(() => useAutomationLayout());
    act(() => result.current[1]({ automationPaneWidth: 520 }));
    expect(result.current[0].automationPaneWidth).toBe(520);
    expect(readStoredWidths().automationPaneWidth).toBe(520);
  });

  it("never trusts what storage holds: bad values fall back, big ones are clamped", () => {
    localStorage.setItem(AUTOMATION_LAYOUT_KEY, "{not json");
    expect(readStoredWidths()).toEqual({ automationNavWidth: 220, automationPaneWidth: 440 });
    localStorage.setItem(AUTOMATION_LAYOUT_KEY, JSON.stringify({ automationNavWidth: "wide", automationPaneWidth: 99999 }));
    expect(readStoredWidths()).toEqual({ automationNavWidth: 220, automationPaneWidth: 960 });
  });

  it("still works when storage refuses", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const { result } = renderHook(() => useAutomationLayout());
    act(() => result.current[1]({ automationNavWidth: 300 }));
    expect(result.current[0].automationNavWidth).toBe(300);
  });
});
