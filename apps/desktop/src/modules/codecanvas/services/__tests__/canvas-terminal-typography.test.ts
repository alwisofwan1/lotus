import { describe, expect, it, vi } from "vitest";
import {
  CANVAS_TERMINAL_TYPOGRAPHY,
  forceFontFamilyRemeasure,
  remeasureTerminalAfterFontLoad,
  resolveCanvasTerminalFontFamily,
} from "../canvas-terminal-typography";

vi.mock("@/lib/fonts", () => ({
  detectMonoFontFamily: () => '"JetBrains Mono", "JetBrainsMono Nerd Font", Menlo, monospace',
}));

describe("CANVAS_TERMINAL_TYPOGRAPHY", () => {
  it("is one type scale for every canvas terminal", () => {
    // The Terminal Node ran at 13/1.12 (the deliberately tuned codespace metrics) while the Live
    // Agent Terminal ran at 12/1.3 — copied from the Swarm PTY panel. Side by side on one board
    // that is an ~8% size and ~16% leading mismatch between two nodes of the same family.
    expect(CANVAS_TERMINAL_TYPOGRAPHY).toEqual({
      fontSize: 13,
      lineHeight: 1.12,
      letterSpacing: 0,
      fontWeight: 400,
      fontWeightBold: 700,
    });
  });

  it("asks for a bold weight the loaded face actually has", () => {
    // layout.tsx imports @fontsource/jetbrains-mono 400 + 700 only. Requesting 650 made CSS font
    // matching promote to 700 anyway — so name 700 and stop pretending 650 is a face.
    expect(CANVAS_TERMINAL_TYPOGRAPHY.fontWeightBold).toBe(700);
  });
});

describe("resolveCanvasTerminalFontFamily", () => {
  it("leads with JetBrains Mono", () => {
    expect(resolveCanvasTerminalFontFamily().startsWith('"JetBrains Mono"')).toBe(true);
  });

  it("carries the detected Nerd Font fallbacks so prompt glyphs are not tofu", () => {
    // The Live Agent Terminal used a hardcoded stack with no Nerd Font entry, so powerline and
    // devicon glyphs in an agent's prompt fell through to 'Apple Symbols' or tofu. Routing
    // through detectMonoFontFamily() gives both node families the same coverage.
    expect(resolveCanvasTerminalFontFamily()).toContain("JetBrainsMono Nerd Font");
  });
});

describe("forceFontFamilyRemeasure", () => {
  // The whole point of the re-measure. xterm's option setter is GUARDED — from the shipped
  // bundle: `this.rawOptions[e] !== i && (this.rawOptions[e] = i, this._onOptionChange.fire(e))`
  // — and CharSizeService only re-measures via
  // `onMultipleOptionChange(["fontFamily","fontSize"], () => this.measure())`. Because
  // detectMonoFontFamily() caches its stack, assigning the resolved family back onto a terminal
  // that was CONSTRUCTED with that same string changes nothing, fires nothing, and leaves the
  // stale fallback cell width in place. Re-assignment alone is a no-op, so this helper has to
  // move the value through something different first.

  it("ends on the real resolved stack", () => {
    const setFontFamily = vi.fn();
    forceFontFamilyRemeasure(setFontFamily, () => '"JetBrains Mono", monospace');
    expect(setFontFamily.mock.calls.at(-1)?.[0]).toBe('"JetBrains Mono", monospace');
  });

  it("actually changes the option value so xterm's guarded setter fires", () => {
    const setFontFamily = vi.fn();
    forceFontFamilyRemeasure(setFontFamily, () => '"JetBrains Mono", monospace');

    const assigned = setFontFamily.mock.calls.map((c) => c[0] as string);
    expect(assigned.length).toBeGreaterThanOrEqual(2);
    // Every consecutive pair must differ, or the guard swallows that assignment.
    for (let i = 1; i < assigned.length; i += 1) {
      expect(assigned[i]).not.toBe(assigned[i - 1]);
    }
  });

  it("still moves the value when the resolved stack IS the sentinel", () => {
    // Degenerate but real: on a machine where nothing resolves, the stack can collapse to a bare
    // generic. The helper must not pick a sentinel equal to the value it is about to set.
    const setFontFamily = vi.fn();
    forceFontFamilyRemeasure(setFontFamily, () => "monospace");

    const assigned = setFontFamily.mock.calls.map((c) => c[0] as string);
    expect(assigned.at(-1)).toBe("monospace");
    expect(assigned.at(-2)).not.toBe("monospace");
  });

  it("defaults to the canvas terminal stack when no resolver is passed", () => {
    const setFontFamily = vi.fn();
    forceFontFamilyRemeasure(setFontFamily);
    expect(setFontFamily.mock.calls.at(-1)?.[0]).toBe(resolveCanvasTerminalFontFamily());
  });
});

describe("remeasureTerminalAfterFontLoad", () => {
  function deps(overrides: Partial<Parameters<typeof remeasureTerminalAfterFontLoad>[0]> = {}) {
    return {
      isPrimaryFontLoaded: vi.fn(() => false),
      fontsReady: vi.fn(async () => {}),
      isDisposed: vi.fn(() => false),
      reapplyFontFamily: vi.fn(),
      refit: vi.fn(),
      ...overrides,
    };
  }

  it("does nothing when the primary face was already loaded at construct time", async () => {
    // xterm measures the glyph cell in its constructor. If JetBrains Mono was already resident,
    // that measurement is correct and a forced re-measure is a wasted full reflow.
    const d = deps({ isPrimaryFontLoaded: vi.fn(() => true) });
    await expect(remeasureTerminalAfterFontLoad(d)).resolves.toBe("already-loaded");
    expect(d.fontsReady).not.toHaveBeenCalled();
    expect(d.reapplyFontFamily).not.toHaveBeenCalled();
    expect(d.refit).not.toHaveBeenCalled();
  });

  it("re-applies the family and refits once the font swaps in", async () => {
    // fontsource ships font-display: swap, so a terminal built on the very first frame measures
    // the fallback (Menlo) and keeps that cell width until something forces a re-measure.
    const d = deps();
    await expect(remeasureTerminalAfterFontLoad(d)).resolves.toBe("remeasured");
    expect(d.reapplyFontFamily).toHaveBeenCalledTimes(1);
    expect(d.refit).toHaveBeenCalledTimes(1);
  });

  it("touches nothing when the node was disposed while the font was loading", async () => {
    const d = deps({ isDisposed: vi.fn(() => true) });
    await expect(remeasureTerminalAfterFontLoad(d)).resolves.toBe("disposed");
    expect(d.reapplyFontFamily).not.toHaveBeenCalled();
    expect(d.refit).not.toHaveBeenCalled();
  });

  it("survives a font API that rejects", async () => {
    // document.fonts.ready can reject in a WKWebView mid-teardown. A failed re-measure must not
    // surface as an unhandled rejection — the terminal is still usable on the fallback metrics.
    const d = deps({ fontsReady: vi.fn(async () => { throw new Error("font api gone"); }) });
    await expect(remeasureTerminalAfterFontLoad(d)).resolves.toBe("font-api-failed");
    expect(d.reapplyFontFamily).not.toHaveBeenCalled();
    expect(d.refit).not.toHaveBeenCalled();
  });

  it("reapplies before refitting, so the refit measures the real face", async () => {
    const order: string[] = [];
    const d = deps({
      reapplyFontFamily: vi.fn(() => order.push("reapply")),
      refit: vi.fn(() => order.push("refit")),
    });
    await remeasureTerminalAfterFontLoad(d);
    expect(order).toEqual(["reapply", "refit"]);
  });
});
