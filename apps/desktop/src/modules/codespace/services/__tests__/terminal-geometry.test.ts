import { describe, expect, it, vi } from "vitest";
import { hasTerminalObservedSizeChanged, measureTerminalGeometry, shouldSkipFit } from "../terminal-geometry";

function makeElement(width: number, height: number) {
  const element = document.createElement("div");
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return element;
}

describe("measureTerminalGeometry", () => {
  it("does not fit or accept geometry from an invisible container", () => {
    const fit = vi.fn();

    const geometry = measureTerminalGeometry({
      container: makeElement(0, 420),
      fitAddon: { fit },
      term: { cols: 120, rows: 32 },
    });

    expect(geometry).toBeNull();
    expect(fit).not.toHaveBeenCalled();
  });

  it("fits the terminal and returns valid cols and rows", () => {
    const term = { cols: 120, rows: 32 };
    const fit = vi.fn(() => {
      term.cols = 118;
      term.rows = 29;
    });

    const geometry = measureTerminalGeometry({
      container: makeElement(900, 480),
      fitAddon: { fit },
      term,
    });

    expect(fit).toHaveBeenCalledOnce();
    expect(geometry).toMatchObject({
      cols: 118,
      rows: 29,
      width: 900,
      height: 480,
    });
  });
});

describe("hasTerminalObservedSizeChanged", () => {
  it("ignores sub-pixel ResizeObserver jitter", () => {
    expect(hasTerminalObservedSizeChanged(
      { width: 900.2, height: 480.4 },
      { width: 900.8, height: 480.9 },
    )).toBe(false);
  });

  it("accepts meaningful one-pixel container changes", () => {
    expect(hasTerminalObservedSizeChanged(
      { width: 900.2, height: 480.4 },
      { width: 901.2, height: 480.4 },
    )).toBe(true);
  });

  it("rejects non-visible container sizes", () => {
    expect(hasTerminalObservedSizeChanged(null, { width: 0, height: 480 })).toBe(false);
    expect(hasTerminalObservedSizeChanged(null, { width: 900, height: 0 })).toBe(false);
  });
});

describe("shouldSkipFit (char-cell snap)", () => {
  it("never skips when last dimensions are unknown (first fit)", () => {
    expect(shouldSkipFit(null, null, 120, 32)).toBe(false);
    expect(shouldSkipFit(null, 32, 120, 32)).toBe(false);
    expect(shouldSkipFit(120, null, 120, 32)).toBe(false);
  });

  it("skips when proposed dimensions match last fitted exactly", () => {
    expect(shouldSkipFit(120, 32, 120, 32)).toBe(true);
  });

  it("does not skip when cols changes", () => {
    expect(shouldSkipFit(120, 32, 121, 32)).toBe(false);
  });

  it("does not skip when rows changes", () => {
    expect(shouldSkipFit(120, 32, 120, 31)).toBe(false);
  });

  it("does not skip when proposal is null/undefined (caller should treat as 'fit anyway')", () => {
    expect(shouldSkipFit(120, 32, null, null)).toBe(false);
    expect(shouldSkipFit(120, 32, undefined, undefined)).toBe(false);
    expect(shouldSkipFit(120, 32, 120, undefined)).toBe(false);
  });

  it("does not skip on non-finite proposals", () => {
    expect(shouldSkipFit(120, 32, Number.NaN, 32)).toBe(false);
    expect(shouldSkipFit(120, 32, Number.POSITIVE_INFINITY, 32)).toBe(false);
  });
});
