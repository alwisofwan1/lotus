import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "../builtin-themes";
import { resolveCanvasTheme } from "../resolve-canvas-theme";

/**
 * Contrast floors for anything painted ON the chrome accent.
 *
 * The accent fill is where a theme is most likely to betray a control, because six of the seven
 * built-ins choose a NEAR-WHITE chrome accent (#f5f2ef, #cdd9f5, #dfe9ff, #ffd9b0, #d6eefb,
 * #dfe7f5) and one chooses a dark red. Any component that hardcodes a light foreground is
 * therefore correct on exactly one theme and invisible on the rest.
 *
 * That is not hypothetical: the settings switch shipped with `bg-white` on its knob, which
 * measures 1.12:1 against Void's accent — a control with no visible state at all. This file
 * exists so that regression is a number, not a screenshot someone has to notice.
 *
 * WCAG 2.1 (PRODUCT.md targets AA):
 *   1.4.3  text on the accent pill        4.5:1
 *   1.4.11 the knob, a non-text control   3:1
 * We hold the ink to the text bar, since it serves both roles.
 */

type RGB = [number, number, number];

function toRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as RGB;
}

function relativeLuminance(rgb: RGB): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(toRgb(a)), relativeLuminance(toRgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA_TEXT = 4.5;

describe("accent ink contrast", () => {
  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    "%s: the resolved ink is legible on its own accent",
    (id, theme) => {
      const v = resolveCanvasTheme(theme) as Record<string, string>;
      const ratio = contrast(v["--canvas-accent-fg"], v["--canvas-accent"]);
      expect(
        ratio,
        `${id}: --canvas-accent-fg ${v["--canvas-accent-fg"]} on --canvas-accent ${v["--canvas-accent"]} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it("would fail a hardcoded white foreground, so the floor above is not vacuous", () => {
    // The guard is only worth having if it catches the bug that motivated it. Five themes must
    // reject #ffffff outright — if this ever passes, the catalog's accents have changed shape
    // and the floor above stopped testing anything.
    const failing = BUILTIN_THEMES.filter((t) => {
      const v = resolveCanvasTheme(t) as Record<string, string>;
      return contrast("#ffffff", v["--canvas-accent"]) < 3;
    });
    expect(failing.length).toBeGreaterThanOrEqual(5);
  });
});

describe("the accent fallback pair in theme.css", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles/canvas/theme.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const fallbackOf = (token: string): string => {
    // The last comma-separated arm of the declaration, i.e. what renders with no --ct-* source.
    const decl = css.match(new RegExp(`${token}\\s*:\\s*([^;]+);`))?.[1] ?? "";
    return (decl.match(/#[0-9a-fA-F]{3,8}/g) ?? []).at(-1) ?? "";
  };

  it("pairs the accent fallback with an ink that is legible on it", () => {
    // These two literals are what a shell paints before CanvasPage injects the resolved theme.
    // They used to be #f5f2ef and #ffffff: 1.05:1, a white label on a white pill.
    const accent = fallbackOf("--canvas-accent");
    const ink = fallbackOf("--canvas-accent-fg");
    expect(accent).toMatch(/^#/);
    expect(ink).toMatch(/^#/);
    expect(
      contrast(ink, accent),
      `first-paint fallbacks ${ink} on ${accent} are ${contrast(ink, accent).toFixed(2)}:1 — change one and you must change the other`,
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("does not close a var cycle with --accent-fg", () => {
    // The isolation block sets `--accent-fg: var(--canvas-accent-fg)`. If this declaration names
    // --accent-fg in its fallback, the two reference each other and BOTH are invalid at
    // computed-value time whenever --ct-canvas-accent-fg is absent — first paint, or any shell
    // rendered without a theme. Every call site then takes its own `#ffffff` fallback.
    //
    // Confirmed in a browser, because the shape is counter-intuitive: with the --ct-* source
    // present the identical pair resolves fine, so the failure only appears un-themed.
    const decl = css.match(/--canvas-accent-fg\s*:\s*([^;]+);/)?.[1] ?? "";
    expect(decl).toMatch(/var\(\s*--ct-canvas-accent-fg\s*,/);
    expect(decl, "naming --accent-fg here closes a cycle").not.toMatch(/--accent-fg/);
  });
});

describe("switch and segmented control states", () => {
  // The controls live in the global UI kit now (mockups/settings-redesign.html); same invariants.
  const kit = readFileSync(resolve(process.cwd(), "src/styles/ui-kit.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it.each([[".ui-switch"], [".ui-seg-btn"]])("%s has a visible focus state", (sel) => {
    // PRODUCT.md: keyboard navigation and focus visibility. The kit draws a ring, not an outline.
    expect(kit).toMatch(new RegExp(`\\${sel}:focus-visible\\s*\\{[^}]*box-shadow:\\s*var\\(--ui-ring\\)`));
  });

  it("clears the pressed button fill only when the sliding pill renders", () => {
    // Under reduced motion no pill renders, and an unconditional clear would leave no visible selection.
    expect(kit).toMatch(/\.ui-seg-btn\[aria-pressed="true"\][^{]*\{[^}]*background:\s*var\(--ui-card\)/);
    expect(kit).toMatch(
      /\.ui-seg\[data-pill="on"\]\s+\.ui-seg-btn\[aria-pressed="true"\]\s*\{[^}]*background:\s*transparent/,
    );
  });

  it("takes each knob state's colour from a token", () => {
    // ON sits on the accent, so it takes the accent's ink. A literal here is the original bug (`bg-white`).
    const knob = kit.match(/\.ui-switch-knob\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(knob).toMatch(/background:\s*var\(--ui-/);
    expect(kit).toMatch(
      /\.ui-switch\[aria-checked="true"\]\s+\.ui-switch-knob\s*\{[^}]*background:\s*var\(--ui-accent-ink\)/,
    );
    expect(knob, "a literal knob colour cannot be right on six themes").not.toMatch(/#[0-9a-f]{3,8}|\bwhite\b/i);
  });

  it("animates the knob with transform, never a layout property", () => {
    const knob = kit.match(/\.ui-switch-knob\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(knob).toMatch(/transition:[^;]*transform/);
    expect(knob).not.toMatch(/transition:[^;]*\b(left|right|width|margin)\b/);
  });

  it("stands down for prefers-reduced-motion", () => {
    expect(kit).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.ui-switch[\s\S]*?transition:\s*none/);
  });
});

/**
 * One switch, not four.
 *
 * The contrast fix above reached exactly one of the four hand-rolled copies that existed, and the
 * Runners tab kept rendering a white knob on a near-white track for another round. What made that
 * possible was not the copies themselves but that each looked locally correct: RunnersTab's even
 * carried a comment saying "one place so the track/knob stay identical", which was true inside
 * that file and false across the other three.
 *
 * So the guard is structural rather than visual. A colour assertion would have passed on the one
 * component that was fixed; only counting the implementations catches the other three.
 */
describe("the settings switch has a single implementation", () => {
  // The section components stay in codecanvas; the generic controls moved to the Lotus Settings frame.
  const DIRS = ["src/modules/codecanvas/components/settings", "src/modules/lotus-settings/components", "src/modules/lotus-settings/sections", "src/modules/settings/components", "src/components/ui"].map((d) => resolve(process.cwd(), d));

  const componentFiles = (): string[] => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.name === "__tests__"
          ? []
          : e.isDirectory()
            ? walk(`${dir}/${e.name}`)
            : e.name.endsWith(".tsx")
              ? [`${dir}/${e.name}`]
              : [],
      );
    return DIRS.flatMap(walk);
  };

  it("declares role=\"switch\" in exactly one file", () => {
    const owners = componentFiles().filter((f) =>
      readFileSync(f, "utf8").includes('role="switch"'),
    );
    expect(
      owners.map((f) => f.split("/").pop()),
      "a new toggle should render the global <Switch> (components/ui/switch), not its own button",
    ).toEqual(["switch.tsx"]);
  });

  it("keeps every colour decision out of the component", () => {
    // The moment a call site can pass a colour, the copies come back — differing slightly, each
    // defensible on its own. `.ui-switch` (styles/ui-kit.css) owns the palette; the component owns behaviour.
    const src = readFileSync(`${DIRS[4]}/switch.tsx`, "utf8");
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/style=\{\{/);
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}|\bbg-white\b|var\(--/);
  });

  it("leaves no hand-rolled track or knob behind", () => {
    // The exact markup all four copies shared. MobileTab's `bg-white` is a QR code's quiet zone,
    // which genuinely must be white, so match on the knob's full shape rather than the colour.
    const offenders: string[] = [];
    for (const f of componentFiles()) {
      const src = readFileSync(f, "utf8");
      if (/inline-block h-3 w-3 rounded-full bg-white/.test(src)) offenders.push(f.split("/").pop()!);
      if (/relative inline-flex h-4 w-7[^"]*rounded-full/.test(src)) offenders.push(f.split("/").pop()!);
    }
    expect(offenders).toEqual([]);
  });
});
