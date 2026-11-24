import { describe, expect, it, vi } from "vitest";
import {
  createTerminalV2NativeSearchApi,
  notifyTerminalV2NativeSearchReady,
  type TerminalV2NativeSearchAddon,
} from "../terminal-v2-native-search";

describe("Terminal V2 native search helper", () => {
  it("adapts search addon methods to the public search API", () => {
    const searchAddon = {
      findNext: vi.fn<TerminalV2NativeSearchAddon["findNext"]>(() => true),
      findPrevious: vi.fn<TerminalV2NativeSearchAddon["findPrevious"]>(() => false),
      clearDecorations: vi.fn(),
    };

    const api = createTerminalV2NativeSearchApi(searchAddon);

    expect(api?.findNext("foo")).toBe(true);
    expect(api?.findNext("live", "live")).toBe(true);
    expect(api?.findPrevious("bar")).toBe(false);
    api?.clearSearch();

    const nextOptions = searchAddon.findNext.mock.calls[0]?.[1];
    const liveOptions = searchAddon.findNext.mock.calls[1]?.[1];
    const previousOptions = searchAddon.findPrevious.mock.calls[0]?.[1];
    expect(nextOptions).toEqual(expect.objectContaining({
      decorations: expect.objectContaining({ activeMatchBackground: "#d18616" }),
    }));
    expect(nextOptions).not.toHaveProperty("incremental");
    expect(liveOptions).toEqual(expect.objectContaining({
      decorations: expect.objectContaining({ matchBackground: "#515c6a" }),
      incremental: true,
    }));
    expect(previousOptions).toEqual(expect.objectContaining({
      decorations: expect.objectContaining({
        matchBackground: "#515c6a",
        matchOverviewRuler: "#d18616",
      }),
    }));
    expect(nextOptions?.decorations).not.toHaveProperty("activeMatchBorder");
    expect(nextOptions?.decorations).not.toHaveProperty("matchBorder");
    expect(searchAddon.clearDecorations).toHaveBeenCalled();
  });

  it("falls back to terminal buffer selection when the addon does not expose a visible match", () => {
    const searchAddon = {
      findNext: vi.fn(() => false),
      findPrevious: vi.fn(() => false),
      clearDecorations: vi.fn(),
    };
    const terminal = {
      buffer: {
        active: {
          length: 1,
          baseY: 0,
          cursorY: 0,
          getLine: () => ({ translateToString: () => "Pantun 1 - Tentang Semangat" }),
        },
      },
      clearSelection: vi.fn(),
      getSelection: vi.fn(() => ""),
      getSelectionPosition: vi.fn(() => undefined),
      hasSelection: vi.fn(() => false),
      refresh: vi.fn(),
      scrollToLine: vi.fn(),
      select: vi.fn(),
    };

    const api = createTerminalV2NativeSearchApi(searchAddon, terminal);

    expect(api?.findNext("semangat", "live")).toBe(true);
    expect(terminal.select).toHaveBeenCalledWith(19, 0, "semangat".length);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 0);
    api?.clearSearch();
    expect(searchAddon.clearDecorations).toHaveBeenCalledOnce();
    expect(terminal.clearSelection).toHaveBeenCalledOnce();
  });

  it("repaints a reported xterm selection so search remains visible in Tauri", () => {
    const searchAddon = {
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      clearDecorations: vi.fn(),
    };
    const terminal = {
      clearSelection: vi.fn(),
      getSelection: vi.fn(() => "kebon"),
      getSelectionPosition: vi.fn(() => ({ start: { x: 21, y: 4 }, end: { x: 26, y: 4 } })),
      hasSelection: vi.fn(() => true),
      refresh: vi.fn(),
      scrollToLine: vi.fn(),
      select: vi.fn(),
    };

    const api = createTerminalV2NativeSearchApi(searchAddon, terminal);

    expect(api?.findNext("kebon", "live")).toBe(true);
    expect(searchAddon.findNext).toHaveBeenCalledOnce();
    expect(terminal.select).toHaveBeenCalledWith(21, 4, "kebon".length);
    expect(terminal.refresh).toHaveBeenCalledWith(4, 4);
  });

  it("notifies once for a search addon identity", () => {
    const onSearchReady = vi.fn();
    const notified = { current: null as object | null };
    const searchAddon = {
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      clearDecorations: vi.fn(),
    };

    expect(notifyTerminalV2NativeSearchReady({ notifiedSearchAddonRef: notified, onSearchReady, searchAddon })).toBe(true);
    expect(notifyTerminalV2NativeSearchReady({ notifiedSearchAddonRef: notified, onSearchReady, searchAddon })).toBe(false);

    expect(onSearchReady).toHaveBeenCalledOnce();
  });
});
