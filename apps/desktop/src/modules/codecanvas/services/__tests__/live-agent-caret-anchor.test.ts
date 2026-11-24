import { describe, expect, it } from "vitest";
import { caretAnchorOffset } from "../live-agent-caret-anchor";
import type { RectLike } from "../dispatch-comet";

function rect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, width, height };
}

describe("caretAnchorOffset", () => {
  const body = rect(1000, 500, 300, 260);

  it("tracks the real xterm cursor row, relative to the node body", () => {
    // cursor sits well above the node's bottom edge (there's a TUI footer below it)
    const cursor = rect(1020, 660, 8, 16);
    expect(caretAnchorOffset({ cursor, body, fallback: { cursorY: 0, cellHeight: 0 } })).toEqual({
      top: 160, // 660 - 500
      height: 16,
    });
  });

  it("does NOT land at the node's bottom edge — the caret is above the footer", () => {
    const cursor = rect(1020, 640, 8, 16);
    const { top, height } = caretAnchorOffset({ cursor, body, fallback: { cursorY: 0, cellHeight: 0 } });
    // 140 + 16 = 156, comfortably above the body's height (260)
    expect(top + height).toBeLessThan(body.height);
  });

  it("falls back to cursor-row × cell-height when the cursor element can't be measured", () => {
    expect(caretAnchorOffset({ cursor: null, body, fallback: { cursorY: 12, cellHeight: 18 } })).toEqual({
      top: 216, // 12 * 18
      height: 18,
    });
  });

  it("falls back when the cursor element has zero height", () => {
    const cursor = rect(1020, 660, 8, 0);
    expect(caretAnchorOffset({ cursor, body, fallback: { cursorY: 5, cellHeight: 20 } })).toEqual({
      top: 100,
      height: 20,
    });
  });

  it("uses a sane minimum row height when nothing is measurable", () => {
    const result = caretAnchorOffset({ cursor: null, body, fallback: { cursorY: 0, cellHeight: 0 } });
    expect(result.height).toBeGreaterThan(0);
  });

  it("never returns a negative top", () => {
    const cursor = rect(1020, 480, 8, 16); // cursor above the body (edge case)
    expect(caretAnchorOffset({ cursor, body, fallback: { cursorY: -3, cellHeight: 18 } }).top).toBe(0);
  });
});
