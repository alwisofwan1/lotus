import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalV2FocusSearch } from "../useTerminalV2FocusSearch";

describe("useTerminalV2FocusSearch", () => {
  it("focuses the current renderer terminal", () => {
    const terminal = { rows: 24, focus: vi.fn() };

    const { result } = renderHook(() => useTerminalV2FocusSearch({}));
    result.current.onRendererHandlesReady({ terminal });
    result.current.focus();

    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it("clears the focused terminal on cleanup", () => {
    const terminal = { rows: 24, focus: vi.fn() };

    const { result } = renderHook(() => useTerminalV2FocusSearch({}));
    const cleanup = result.current.onRendererHandlesReady({ terminal });
    cleanup();
    result.current.focus();

    expect(terminal.focus).not.toHaveBeenCalled();
  });

  it("stores and forwards the search api", () => {
    const onSearchReady = vi.fn();
    const searchApi = {
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => false),
      clearSearch: vi.fn(),
    };

    const { result } = renderHook(() => useTerminalV2FocusSearch({ onSearchReady }));
    result.current.onSearchReady(searchApi);

    expect(onSearchReady).toHaveBeenCalledWith(searchApi);
    expect(result.current.getSearchApi()).toBe(searchApi);
  });
});
