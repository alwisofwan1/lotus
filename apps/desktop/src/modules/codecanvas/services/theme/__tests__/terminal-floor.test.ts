import { describe, it, expect } from "vitest";
import { flattenPaperBase, resolveTerminalFloor } from "../terminal-floor";
import { BUILTIN_THEMES, defaultCanvasTheme } from "../builtin-themes";
import type { CanvasTheme } from "../../../types/canvas-theme";

/**
 * The canvas terminal floor (plans/canvas-terminal-opaque-floor).
 *
 * WHY THIS EXISTS: `LiveAgentNode` built xterm with `allowTransparency: true` and no renderer
 * addon, so every frame went through WebKit's DOM renderer with per-cell alpha compositing —
 * measured at 30% of the webview main thread in CoreText shaping + WebCore layout. An opaque
 * floor lets both the DOM and WebGL renderers take the background-run fast path.
 *
 * The floor colour therefore has to be a CONCRETE opaque colour, resolvable in plain JS:
 *   • xterm cannot read CSS variables — it needs a literal in `theme.background`.
 *   • The CSS floor must be the SAME value, or the node shows a seam where xterm's
 *     background meets the viewport's.
 *
 * The trap this suite guards (already documented at node-shell.css:198): `paper.fill` is a
 * GRADIENT on four of the five builtins, and `color-mix()` with a gradient is invalid — the
 * whole declaration silently collapses to transparent black. So the flattening happens here,
 * in JS, never in CSS.
 */

const themes = Object.values(BUILTIN_THEMES) as CanvasTheme[];
const byId = (id: string): CanvasTheme => {
  const t = themes.find((x) => x.id === id);
  if (!t) throw new Error(`builtin theme missing: ${id}`);
  return t;
};

/** WCAG relative luminance, used for the contrast contract below. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The terminal foregrounds from canvas-terminal-theme.ts, per mode. */
const TERMINAL_INK: Record<"dark" | "light", [number, number, number]> = {
  dark: [232, 238, 246],
  light: [31, 39, 51],
};

/**
 * Contrast of a floor against the terminal foreground that will actually be painted on it.
 *
 * The mode argument is not cosmetic. This used to assume DARK_MODE's near-white ink for every
 * theme, which was true only while every builtin was dark: Garden of Dawn's floor is a warm page,
 * and measured against ink it never receives it scores 1.08:1 — a "failure" describing a
 * combination the app cannot produce, since resolveCanvasTerminalTheme hands a light theme the
 * LIGHT_MODE ramp.
 */
function contrastWithInk(floor: string, mode: "dark" | "light" = "dark"): number {
  const [hi, lo] = [relativeLuminance(TERMINAL_INK[mode]), relativeLuminance(rgb(floor))].sort(
    (a, b) => b - a,
  );
  return (hi + 0.05) / (lo + 0.05);
}

/** Parse an `rgb(r, g, b)` string back into numbers so assertions can do maths. */
function rgb(value: string): [number, number, number] {
  const m = value.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  expect(m, `not an opaque rgb() string: ${value}`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

describe("flattenPaperBase", () => {
  it("returns a flat hex fill unchanged, as opaque rgb", () => {
    // Void: paper.fill is a plain colour, not a gradient.
    expect(flattenPaperBase("#050506")).toBe("rgb(5, 5, 6)");
  });

  it("expands shorthand hex", () => {
    expect(flattenPaperBase("#fff")).toBe("rgb(255, 255, 255)");
  });

  it("averages every colour stop of a linear gradient", () => {
    // Lakeside's authored fill — the painterly stand-in for the photo behind it.
    const out = flattenPaperBase("linear-gradient(180deg, #3a2238 0%, #221426 55%, #120a16 100%)");
    // (58+34+18)/3, (34+20+10)/3, (56+38+22)/3
    expect(out).toBe("rgb(37, 21, 39)");
  });

  it("ignores gradient geometry so percentages and angles never read as colour", () => {
    // "50%", "0%", "180deg" and "ellipse at 55% 18%" must not perturb the average.
    const withGeometry = flattenPaperBase(
      "radial-gradient(ellipse at 55% 18%, #1a3a6b 0%, #0d2147 40%, #071328 74%, #040a18 100%)",
    );
    const bare = flattenPaperBase("#1a3a6b #0d2147 #071328 #040a18");
    expect(withGeometry).toBe(bare);
  });

  it("uses the rgb channels of rgba() stops and drops their alpha", () => {
    expect(flattenPaperBase("linear-gradient(rgba(20, 40, 60, 0.5), rgba(20, 40, 60, 0.5))")).toBe(
      "rgb(20, 40, 60)",
    );
  });

  it("falls back to a dark neutral when a fill carries no parseable colour", () => {
    // Never throw and never return a gradient: a bad theme must not black out the terminal.
    expect(flattenPaperBase("var(--something-unresolvable)")).toBe("rgb(8, 8, 12)");
    expect(flattenPaperBase("")).toBe("rgb(8, 8, 12)");
  });
});

describe("resolveTerminalFloor — contract shared by every builtin theme", () => {
  it.each(themes.map((t) => [t.id, t] as const))(
    "%s yields an opaque, literal floor colour",
    (_id, theme) => {
      const floor = resolveTerminalFloor(theme);

      // xterm parses this string itself — it must be a literal, never a CSS function.
      expect(floor.background).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
      expect(floor.background).not.toContain("gradient");
      expect(floor.background).not.toContain("color-mix");
      expect(floor.background).not.toContain("var(");

      // The whole point: the renderer gets to assume an opaque background.
      expect(floor.allowTransparency).toBe(false);
    },
  );

  it("clears AAA contrast against the terminal ink on every builtin", () => {
    // The property that actually matters. A brightness cap was the previous stand-in for this
    // and it was a bad proxy: it failed a perfectly legible navy while passing colours no one
    // had checked. WCAG AA for body text is 4.5; terminals are read for hours, so the floor is
    // held to AAA (7) with room to spare.
    for (const theme of themes) {
      const ratio = contrastWithInk(resolveTerminalFloor(theme).background, theme.mode);
      expect(
        ratio,
        `${theme.id} (${theme.mode}) floor contrast ${ratio.toFixed(1)}:1`,
      ).toBeGreaterThanOrEqual(7);
    }
  });

  it("never lets a bright theme source dominate the floor", () => {
    // Lakeside Day's photograph is bright foliage. Without the luminance ceiling the floor
    // inherits that brightness wholesale and stops reading as a terminal ground.
    const [, g] = rgb(resolveTerminalFloor(byId("lakeside-day")).background);
    expect(g).toBeLessThan(48);
  });

  it("derives Void's floor from its glass stack, not from the raw paper colour", () => {
    // Void paper is #050506. The floor sits UNDER ink+glass, so it must land above it —
    // otherwise the flattening silently did nothing.
    const floor = rgb(resolveTerminalFloor(byId("void")).background);
    expect(floor[0]).toBeGreaterThan(5);
  });

  it("tracks the paper: a lighter theme paper lifts the floor with it", () => {
    // Lakeside's dusk paper is far lighter than Void's near-black, so its floor must
    // land lighter too. If the floor ignored paper.fill these would collapse together.
    const lake = rgb(resolveTerminalFloor(byId("lakeside")).background);
    const voidFloor = rgb(resolveTerminalFloor(byId("void")).background);
    const sum = (c: [number, number, number]) => c[0] + c[1] + c[2];
    expect(sum(lake)).toBeGreaterThan(sum(voidFloor));
  });

  it("gives each builtin its own floor — no two themes collapse to one colour", () => {
    const floors = themes.map((t) => resolveTerminalFloor(t).background);
    expect(new Set(floors).size).toBe(themes.length);
  });
});


describe("resolveTerminalFloor — material decides which panel sits over the paper", () => {
  it("reads the glass panel for glass themes, though only as a tint", () => {
    // The panel contributes 20% of the floor by design, so on the builtins the difference
    // between glass.bg and surface.base rounds away. A deliberately extreme panel proves it is
    // still being read rather than silently ignored.
    // Strip `sampled` first: a photo theme reads its floor from the photograph and never
    // consults the glass panel at all.
    const theme: CanvasTheme = { ...byId("lakeside"), paper: { ...byId("lakeside").paper, sampled: undefined } };
    const withGlass = resolveTerminalFloor({
      ...theme,
      glass: { ...theme.glass!, bg: "rgba(255, 255, 255, 1)" },
    }).background;
    const withoutGlass = resolveTerminalFloor({ ...theme, glass: undefined }).background;
    expect(withGlass).not.toBe(withoutGlass);
  });

  it("falls back to surface.base when a theme declares no glass", () => {
    // theme.css:197-199 — material "solid"/"grain" set --node-glass-bg to --canvas-surface.
    const midnight = byId("midnight");
    expect(midnight.glass).toBeUndefined();
    expect(() => resolveTerminalFloor(midnight)).not.toThrow();
  });

  it("is pure: the same theme always resolves to the same floor", () => {
    const t = defaultCanvasTheme();
    expect(resolveTerminalFloor(t)).toEqual(resolveTerminalFloor(t));
  });
});

describe("resolveTerminalFloor — photo themes take their colour from the photograph", () => {
  it("uses paper.sampled when the theme ships a wallpaper", () => {
    // Lakeside Day's authored fill is pure blue (sky, deep water) while 46% of its photograph
    // is foliage. Deriving from the fill produced a cold navy that read as a hole punched
    // through a green scene; the measured dominant cluster is a deep forest green.
    const floor = rgb(resolveTerminalFloor(byId("lakeside-day")).background);
    const [r, g, b] = floor;
    expect(g, "green must lead a foliage-dominated wallpaper").toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it("keeps the sampled hue when it darkens the colour", () => {
    // Darkening must scale channels together. If it clipped or mixed toward grey, the ratio
    // between channels would drift and the floor would stop belonging to the image.
    const theme = byId("lakeside-day");
    const [r, g, b] = rgb(resolveTerminalFloor(theme).background);
    const src = (theme.paper.sampled ?? "").match(/\d+/g)!.map(Number);
    // Relative tolerance, not absolute: channels are rounded to integers on the way out, which
    // shifts a ratio by a few percent on small numbers. 10% is tight enough to catch a floor
    // that drifted toward grey and loose enough to survive rounding.
    const within10 = (actual: number, expected: number) => {
      expect(actual).toBeGreaterThan(expected * 0.9);
      expect(actual).toBeLessThan(expected * 1.1);
    };
    within10(g / r, src[1] / src[0]);
    within10(g / b, src[1] / src[2]);
  });

  it("leaves an already-dark sample untouched", () => {
    // Lakeside's dusk photograph is dominated by warm earth that is ALREADY darker than the
    // ceiling. Normalising upward would invent brightness the scene does not have.
    expect(resolveTerminalFloor(byId("lakeside")).background).toBe(byId("lakeside").paper.sampled);
  });

  it("falls back to the paper fill when a theme ships no wallpaper", () => {
    const noPhoto = themes.filter((t) => !t.paper.sampled);
    expect(noPhoto.length).toBeGreaterThan(0);
    for (const theme of noPhoto) {
      expect(resolveTerminalFloor(theme).background).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    }
  });

  it("ignores an unparseable sample instead of blacking out the terminal", () => {
    const broken: CanvasTheme = {
      ...byId("void"),
      paper: { ...byId("void").paper, sampled: "not-a-colour" },
    };
    expect(resolveTerminalFloor(broken).background).toBe(resolveTerminalFloor(byId("void")).background);
  });
});

describe("resolveTerminalFloor — darkening preserves the theme's own hue", () => {
  it("leaves a theme that is already dark enough alone", () => {
    // Void is "deep space ink". An earlier model normalised every theme to the SAME lightness,
    // which amplified Void's faint blue cast threefold and turned it teal.
    const [r, g, b] = rgb(resolveTerminalFloor(byId("void")).background);
    expect(Math.max(r, g, b)).toBeLessThan(24);
  });

  it("keeps Cobalt navy rather than pulling it toward its coral accent", () => {
    // The accent belongs to wires, selection, and status. Mixing it into the ground fought the
    // theme's own paper and produced a slate-violet that read as neither.
    const [r, g, b] = rgb(resolveTerminalFloor(byId("cobalt")).background);
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
  });
});

describe("resolveTerminalFloor — light mode inverts the rule", () => {
  // These synthetic themes cover the shapes no builtin has: a light theme with no `sampled`, and
  // one whose paper is dark despite declaring mode:"light". Garden of Dawn covers the real case;
  // Crimson Zen, which it replaced, is what turned the LIGHT_LUMA_FLOOR / LIGHT_PAPER_WEIGHT pair
  // from a guess into a measurement.
  const lightTheme = (over: Partial<CanvasTheme> = {}): CanvasTheme => ({
    ...byId("void"),
    mode: "light",
    material: "solid",
    glass: undefined,
    paper: { fill: "#eef2f7", pattern: "none" },
    surface: { ...byId("void").surface, base: "rgba(255,255,255,0.86)" },
    ...over,
  });

  /** Light-mode terminal ink, from canvas-terminal-theme.ts LIGHT_MODE. */
  const LIGHT_INK_FG: [number, number, number] = [31, 39, 51];
  const contrastWithLightInk = (floor: string) => {
    const [hi, lo] = [relativeLuminance(LIGHT_INK_FG), relativeLuminance(rgb(floor))].sort(
      (a, b) => b - a,
    );
    return (hi + 0.05) / (lo + 0.05);
  };

  it("produces a page, not an ink slab", () => {
    const [r, g, b] = rgb(resolveTerminalFloor(lightTheme()).background);
    expect(Math.min(r, g, b)).toBeGreaterThan(200);
  });

  it("clears AAA contrast against dark terminal ink", () => {
    const ratio = contrastWithLightInk(resolveTerminalFloor(lightTheme()).background);
    expect(ratio, `light floor contrast ${ratio.toFixed(1)}:1`).toBeGreaterThanOrEqual(7);
  });

  it("lifts a dark-papered light theme to the page floor instead of leaving it muddy", () => {
    // A theme can declare mode:"light" while carrying a dark paper. The minimum lightness is
    // what stops that combination from shipping dark ink on a dark ground.
    const muddy = lightTheme({ paper: { fill: "#101014", pattern: "none" } });
    const ratio = contrastWithLightInk(resolveTerminalFloor(muddy).background);
    expect(ratio).toBeGreaterThanOrEqual(7);
  });

  it("still honours a sampled wallpaper colour", () => {
    const withPhoto = lightTheme({
      paper: { fill: "#eef2f7", pattern: "none", sampled: "rgb(120, 150, 110)" },
    });
    // Lifted toward the page, but the sample's green bias must survive the lift.
    const [r, g, b] = rgb(resolveTerminalFloor(withPhoto).background);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });
});
