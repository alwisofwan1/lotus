import { describe, expect, it, vi } from "vitest";
import {
  createTerminalSearchOptions,
  hasVisibleTerminalSearchSelection,
  repaintTerminalSearchSelection,
  selectTerminalSearchFallbackMatch,
  type TerminalSearchFallbackTerminal,
} from "../terminal-search-options";

function terminalWithLines(lines: string[], selection = ""): TerminalSearchFallbackTerminal {
  return {
    buffer: {
      active: {
        length: lines.length,
        baseY: Math.max(0, lines.length - 1),
        cursorY: 0,
        getLine: (index) => ({ translateToString: () => lines[index] ?? "" }),
      },
    },
    clearSelection: vi.fn(),
    getSelection: vi.fn(() => selection),
    getSelectionPosition: vi.fn(() => undefined),
    hasSelection: vi.fn(() => Boolean(selection)),
    refresh: vi.fn(),
    scrollToLine: vi.fn(),
    select: vi.fn(),
  };
}

describe("terminal search options", () => {
  it("uses Terax-style incremental mode only for live search", () => {
    expect(createTerminalSearchOptions("live")).toMatchObject({ incremental: true });
    expect(createTerminalSearchOptions("navigate")).not.toHaveProperty("incremental");
  });

  it("keeps search decorations background-only", () => {
    const options = createTerminalSearchOptions("live");

    expect(options.decorations).toMatchObject({
      matchBackground: "#515c6a",
      activeMatchBackground: "#d18616",
      matchOverviewRuler: "#d18616",
    });
    expect(options.decorations).not.toHaveProperty("matchBorder");
    expect(options.decorations).not.toHaveProperty("activeMatchBorder");
  });

  it("detects when the visible terminal selection already matches the query", () => {
    expect(hasVisibleTerminalSearchSelection(terminalWithLines([], "Semangat"), "semangat")).toBe(true);
    expect(hasVisibleTerminalSearchSelection(terminalWithLines([], "Pantun"), "semangat")).toBe(false);
  });

  it("falls back to selecting a case-insensitive buffer match", () => {
    const terminal = terminalWithLines([
      "Pantun 1 - Tentang Semangat",
      "Bulan bersinar di langit malam",
    ]);

    expect(selectTerminalSearchFallbackMatch({ direction: "next", query: "semangat", terminal })).toBe(true);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(0);
    expect(terminal.select).toHaveBeenCalledWith(19, 0, "semangat".length);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 0);
  });

  it("can keep the current selection start while live-searching a longer query", () => {
    const terminal = terminalWithLines(["Pantun 1 - Tentang Semangat"], "S");
    terminal.getSelectionPosition = vi.fn(() => ({ start: { x: 19, y: 0 }, end: { x: 20, y: 0 } }));

    expect(selectTerminalSearchFallbackMatch({
      direction: "next",
      includeCurrentSelection: true,
      query: "Semangat",
      terminal,
    })).toBe(true);

    expect(terminal.select).toHaveBeenCalledWith(19, 0, "Semangat".length);
  });

  it("repaints an existing xterm search selection without advancing to the next match", () => {
    const terminal = terminalWithLines(["Pergi ke pasar beli kebon,"], "kebon");
    terminal.getSelectionPosition = vi.fn(() => ({ start: { x: 21, y: 0 }, end: { x: 26, y: 0 } }));

    expect(repaintTerminalSearchSelection(terminal, "kebon")).toBe(true);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(terminal.select).toHaveBeenCalledWith(21, 0, "kebon".length);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 0);
  });

  it("does not crash when xterm scrollToLine throws during fallback selection", () => {
    const terminal = terminalWithLines(["Pergi ke pasar beli kebon,"]);
    terminal.scrollToLine = vi.fn(() => {
      throw new TypeError("undefined is not an object (evaluating 'this._renderer.value.dimensions')");
    });

    let result = false;
    expect(() => {
      result = selectTerminalSearchFallbackMatch({ direction: "next", query: "kebon", terminal });
    }).not.toThrow();
    expect(result).toBe(true);
    expect(terminal.select).toHaveBeenCalledWith(20, 0, "kebon".length);
  });

  it("does not call scrollToLine when repainting an existing SearchAddon selection", () => {
    const terminal = terminalWithLines(["Pergi ke pasar beli kebon,"], "kebon");
    terminal.getSelectionPosition = vi.fn(() => ({ start: { x: 21, y: 0 }, end: { x: 26, y: 0 } }));
    terminal.scrollToLine = vi.fn(() => {
      throw new TypeError("undefined is not an object (evaluating 'this._renderer.value.dimensions')");
    });

    let result = false;
    expect(() => {
      result = repaintTerminalSearchSelection(terminal, "kebon");
    }).not.toThrow();
    expect(result).toBe(true);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(terminal.select).toHaveBeenCalledWith(21, 0, "kebon".length);
  });
});
