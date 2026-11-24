import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "../builtin-themes";
import { resolveCanvasTheme } from "../resolve-canvas-theme";

/**
 * CodeCanvas owns its colour inside `.codecanvas-shell`.
 *
 * There are two independent theme systems here: the design-system / CodeSpace theme, written to
 * `:root` by resolve-theme.ts, and the CodeCanvas Artisan theme, written to `.codecanvas-shell`.
 * Canvas components read from BOTH — the app-global names appear 273 times across 22 files in
 * this module, alongside `--canvas-*` reads in the very same components.
 *
 * That went unnoticed for as long as it did because every canvas theme was dark and so was the
 * app theme: the two happened to agree. Garden of Dawn is light, and the disagreement surfaced
 * all at once — Settings rows painted `--fg` (#e8e8f0) on pale paper and vanished, while active
 * segmented pills painted the app theme's Gruvbox `--accent` (#fe8019), a hue in no canvas theme.
 *
 * theme.css now re-declares each of those names from the active theme. This suite guards the
 * remap list against silent shrinkage, because a token dropped from it does not fail loudly —
 * it just quietly inherits the app theme again, which is precisely the bug that hid for months.
 */

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

const THEME_CSS = read("src/styles/canvas/theme.css");

/**
 * Every app-global custom property that canvas components consume, and therefore every one the
 * shell has to answer for itself.
 *
 * Derived from globals.css `:root`, not invented: if a name is added there and canvas code
 * starts reading it, it belongs here too.
 */
const REMAPPED = [
  "--fg",
  "--fg-muted",
  "--text-muted",
  "--text-secondary",
  "--accent",
  "--accent-fg",
  "--border",
  "--border-sub",
  "--bg",
  "--bg-card",
  "--bg-sidebar",
  "--bg-elevated",
  "--bg-hover",
  "--scrollbar",
];

/** The `.codecanvas-shell { … }` base block — the only place the remap may live. */
function shellBlock(): string {
  const start = THEME_CSS.indexOf(".codecanvas-shell {");
  expect(start, "theme.css has no .codecanvas-shell base block").toBeGreaterThan(-1);
  const end = THEME_CSS.indexOf("\n}", start);
  return THEME_CSS.slice(start, end);
}

describe("canvas app-token isolation", () => {
  const block = shellBlock();

  for (const token of REMAPPED) {
    it(`re-declares ${token} inside .codecanvas-shell`, () => {
      // Anchored to a line start so `--bg` cannot be satisfied by `--bg-card`.
      const declared = new RegExp(`^\\s*${token}:`, "m").test(block);
      expect(declared, `${token} is not re-declared — canvas inherits the app theme for it`).toBe(
        true,
      );
    });

    it(`sources ${token} from a canvas token, not a literal`, () => {
      const line = block.match(new RegExp(`^\\s*${token}:.*$`, "m"))?.[0] ?? "";
      expect(line, `${token} must derive from --canvas-*`).toMatch(/var\(--canvas-/);
    });
  }

  it("does not point --bg at --canvas-bg, which is a gradient on most themes", () => {
    // paper.fill is a linear-gradient on five of the six builtins, and every consumer of --bg in
    // this module is an input-field well. Pointing one at the other yields an invalid background
    // and, for anything that color-mix()es it, an invalid declaration that collapses silently.
    // Verified in a real browser: --canvas-bg computes to `linear-gradient(180deg, #a4c0db 0%, …)`
    // on Garden of Dawn.
    const line = block.match(/^\s*--bg:.*$/m)?.[0] ?? "";
    expect(line).not.toMatch(/var\(--canvas-bg/);
  });
});

describe("accent ink is legible on the accent it sits on", () => {
  // The active pill in SettingSegmentedRow paints --accent-fg on --accent. That used to be a
  // hardcoded `#fff`, which is why this test exists: chromeAccent is near-white on ALL SIX dark
  // builtins, so white-on-accent was unreadable on every theme in the catalog, not just the
  // light one. The screenshot that prompted the fix only showed the light case.
  const parse = (hex: string): [number, number, number] => {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const luminance = (rgb: [number, number, number]) => {
    const c = (raw: number) => {
      const v = raw / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * c(rgb[0]) + 0.7152 * c(rgb[1]) + 0.0722 * c(rgb[2]);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const theme of BUILTIN_THEMES) {
    it(`${theme.id}: --canvas-accent-fg clears AA on --canvas-accent`, () => {
      const vars = resolveCanvasTheme(theme);
      const accent = vars["--canvas-accent"];
      const ink = vars["--canvas-accent-fg"];
      expect(ink, `${theme.id}: no accent ink emitted`).toBeTruthy();
      expect(contrast(ink, accent)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
