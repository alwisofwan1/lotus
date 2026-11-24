import { describe, expect, it } from "vitest";
import { ansiPaletteOrder, resolveCanvasTerminalTheme } from "../canvas-terminal-theme";

// Relative luminance (WCAG) for a quick legibility assertion on foreground vs a
// representative surface. Keeps the test about observable contrast, not exact hex.
function luminance(rgb: string): number {
  const m = rgb.match(/(\d+(?:\.\d+)?)/g);
  if (!m) return 0;
  const [r, g, b] = m.slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("resolveCanvasTerminalTheme", () => {
  it("dark mode: xterm is transparent so the CSS ink-floor owns the surface", () => {
    const theme = resolveCanvasTerminalTheme({ mode: "dark" });
    expect(theme.background).toBe("rgba(0, 0, 0, 0)");
  });

  it("dark mode: foreground is a light ink that reads on a dark surface", () => {
    const theme = resolveCanvasTerminalTheme({ mode: "dark" });
    expect(luminance(theme.foreground)).toBeGreaterThan(0.6);
  });

  it("light mode: xterm stays transparent (CSS owns the light ink-floor too)", () => {
    const theme = resolveCanvasTerminalTheme({ mode: "light" });
    expect(theme.background).toBe("rgba(0, 0, 0, 0)");
  });

  it("light mode: foreground flips to a dark ink that reads on a light surface", () => {
    const theme = resolveCanvasTerminalTheme({ mode: "light" });
    expect(luminance(theme.foreground)).toBeLessThan(0.15);
  });

  it("light mode: normal ANSI colours darken so they clear WCAG AA on a light ground", () => {
    const light = resolveCanvasTerminalTheme({ mode: "light" });
    const dark = resolveCanvasTerminalTheme({ mode: "dark" });
    // The dark-mode ANSI ramp is tuned for a dark ground and would wash out on a
    // light surface; light mode must ship deeper variants for the readable set.
    for (const key of ["red", "green", "yellow", "blue", "magenta", "cyan"] as const) {
      expect(luminance(light[key])).toBeLessThan(luminance(dark[key]));
      // AA (4.5:1) against a near-white ink-floor (L≈0.90 → +0.05 offset).
      expect((0.9 + 0.05) / (luminance(light[key]) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * Opaque floor (plans/canvas-terminal-opaque-floor). With `allowTransparency: false` xterm
 * paints the background itself, so it needs a literal colour rather than the transparent
 * stand-in that let the CSS ink-floor show through.
 */
describe("resolveCanvasTerminalTheme — opaque floor", () => {
  it("uses the supplied floor as the xterm background", () => {
    const theme = resolveCanvasTerminalTheme({ mode: "dark", background: "rgb(10, 10, 15)" });
    expect(theme.background).toBe("rgb(10, 10, 15)");
  });

  it("keeps every other palette entry identical to the transparent build", () => {
    // The floor changes the ground, never the ink: swapping it must not silently
    // re-tune the ANSI ramp, cursor, or selection.
    const floored = resolveCanvasTerminalTheme({ mode: "dark", background: "rgb(10, 10, 15)" });
    const transparent = resolveCanvasTerminalTheme({ mode: "dark" });
    expect({ ...floored, background: null }).toEqual({ ...transparent, background: null });
  });

  it("honours the floor in light mode too", () => {
    const theme = resolveCanvasTerminalTheme({ mode: "light", background: "rgb(250, 250, 252)" });
    expect(theme.background).toBe("rgb(250, 250, 252)");
  });

  it("falls back to transparent when no floor is supplied", () => {
    // Back-compat: callers that have not adopted the floor keep the CSS-owned surface.
    expect(resolveCanvasTerminalTheme({ mode: "dark" }).background).toBe("rgba(0, 0, 0, 0)");
    expect(resolveCanvasTerminalTheme({ mode: "dark", background: undefined }).background).toBe(
      "rgba(0, 0, 0, 0)",
    );
  });

  it("does not mutate the shared palette objects between calls", () => {
    // DARK_MODE/LIGHT_MODE are module-level constants; writing the floor into them
    // would leak one node's theme into every other node on the canvas.
    resolveCanvasTerminalTheme({ mode: "dark", background: "rgb(1, 2, 3)" });
    expect(resolveCanvasTerminalTheme({ mode: "dark" }).background).toBe("rgba(0, 0, 0, 0)");
  });
});

describe("ansiPaletteOrder", () => {
  it("lays the 16 slots out in ANSI order, normal then bright", () => {
    // The order is a wire format, not a preference: the normaliser indexes it with `code - 30`
    // and `code - 90 + 8`, so a swap here silently repaints every coloured cell as a different
    // colour with no error anywhere.
    const theme = resolveCanvasTerminalTheme({ mode: "light" });
    const palette = ansiPaletteOrder(theme);

    expect(palette).toHaveLength(16);
    expect(palette[0]).toBe(theme.black);
    expect(palette[1]).toBe(theme.red);
    expect(palette[2]).toBe(theme.green);
    expect(palette[3]).toBe(theme.yellow);
    expect(palette[4]).toBe(theme.blue);
    expect(palette[5]).toBe(theme.magenta);
    expect(palette[6]).toBe(theme.cyan);
    expect(palette[7]).toBe(theme.white);
    expect(palette[8]).toBe(theme.brightBlack);
    expect(palette[9]).toBe(theme.brightRed);
    expect(palette[10]).toBe(theme.brightGreen);
    expect(palette[11]).toBe(theme.brightYellow);
    expect(palette[12]).toBe(theme.brightBlue);
    expect(palette[13]).toBe(theme.brightMagenta);
    expect(palette[14]).toBe(theme.brightCyan);
    expect(palette[15]).toBe(theme.brightWhite);
  });
});
