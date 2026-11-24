import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "../builtin-themes";
import { resolveCanvasTheme } from "../resolve-canvas-theme";
import { validateCanvasThemeSpec } from "../canvas-theme-schema";
import { CANVAS_FONT_WHITELIST } from "../../../types/canvas-theme";

/**
 * The HUD font bucket — the fourth `CanvasFonts` role, and the first OPTIONAL one.
 *
 * It exists because a pixel face is right for an 8-10px status badge and wrong for
 * everything else, so it needed a role of its own rather than a reuse of `display`.
 * Being optional is the entire safety story: five builtins predate the bucket and must
 * render identically without it. Three properties make that true, and none of them are
 * self-evident from reading the diff:
 *
 *   1. `resolveCanvasTheme` emits `--canvas-font-hud` ONLY for a theme that names one.
 *      Emitting a default would have silently repointed the badges on all five.
 *   2. Every CSS consumer spells out the fallback it had before — `var(--canvas-font-hud,
 *      var(--font-mono, …))`. A bare `var(--canvas-font-hud)` would resolve to `unset` on
 *      those themes and the label would inherit the body sans. That failure is invisible
 *      in review and near-invisible on screen, which is exactly why it is asserted here.
 *   3. Consumer font-sizes are whole pixels. A pixel face only aligns to the raster at
 *      integer sizes; the rem values these replaced landed on 8.32px / 9.28px / 9.6px.
 *
 * And one boundary: the terminal and persona headers are NOT consumers. ADR-0033 declares
 * them monospace chrome and canvas-terminal-typography.css.test.ts asserts it; a
 * proportional pixel face is not monospace. That line is checked below too, because "wire
 * the theme font everywhere it looks like chrome" is the obvious next mistake.
 */

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** Strip comments, so a rule that merely *discusses* a token never satisfies an assertion. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match, `missing rule: ${selector}`).not.toBeNull();
  return stripCssComments(match?.[0] ?? "");
}

const agentCss = stripCssComments(read("src/styles/canvas/agent-node.css"));

/** Every rule the HUD bucket is allowed to reach, with the pixel size it must carry. */
const HUD_CONSUMERS: ReadonlyArray<readonly [selector: string, px: number]> = [
  [".agent-status", 8],
  [".agent-card-model", 10],
  [".agent-md-codeblock-language", 9],
  [".agent-transcript-tool", 9],
];

/**
 * Rules that look like HUD candidates and are excluded, with the measured reason.
 *
 * `.agent-card-chip` was in the set until a browser measurement against the dev server
 * showed it truncating: it carries a path inside `max-width: 8.5rem` with ellipsis, and
 * Silkscreen runs ~21% wider than JetBrains Mono at the same size, so
 * "apps/desktop/src/modules" went from 130px (fits the 136px box) to 177px (clips by 43px).
 * A status word that is 10px wider is fine; an identifier that loses its last five
 * characters is not. Hence the rule this pins: anything in a fixed-width box that can
 * truncate keeps the narrow face, however label-like it looks.
 */
const HUD_EXCLUDED: ReadonlyArray<readonly [selector: string, why: string]> = [
  [".agent-card-chip", "truncates inside max-width: 8.5rem — a wider face deletes path characters"],
];

describe("hud font bucket — resolver", () => {
  it("emits nothing for a theme that does not name a hud face", () => {
    for (const theme of BUILTIN_THEMES) {
      if (theme.fonts.hud) continue;
      const vars = resolveCanvasTheme(theme);
      expect(
        "--canvas-font-hud" in vars,
        `${theme.id} must not emit --canvas-font-hud — the CSS fallback is what keeps it unchanged`,
      ).toBe(false);
    }
  });

  it("emits a quoted family with a monospace fallback for a theme that names one", () => {
    // No built-in names a hud face since Lantern Night was removed, so exercise the bucket on a copy.
    const themed = [{ ...BUILTIN_THEMES[0], fonts: { ...BUILTIN_THEMES[0].fonts, hud: "Silkscreen" } }];
    for (const theme of themed) {
      const value = resolveCanvasTheme(theme)["--canvas-font-hud"];
      expect(value).toContain(`"${theme.fonts.hud}"`);
      // The var lands after first paint, so the stack itself must survive a missing face.
      expect(value).toMatch(/monospace/);
    }
  });

  it("keeps the hud face off the three required buckets", () => {
    // Silkscreen as a body face would be unreadable. The whitelist is a flat set at
    // validation time, so this is a catalog-level check, not a schema one.
    const hud = new Set<string>(CANVAS_FONT_WHITELIST.hud);
    for (const theme of BUILTIN_THEMES) {
      for (const role of ["display", "body", "mono"] as const) {
        expect(hud.has(theme.fonts[role]), `${theme.id}: ${role} uses a hud-only face`).toBe(false);
      }
    }
  });
});

describe("hud font bucket — schema", () => {
  it("accepts a spec with no hud at all", () => {
    const { origin: _o, ...spec } = BUILTIN_THEMES[0];
    expect(validateCanvasThemeSpec({ ...spec, id: "no-hud" }).ok).toBe(true);
  });

  it("rejects a hud face that is not on the whitelist", () => {
    const { origin: _o, ...spec } = BUILTIN_THEMES[0];
    const result = validateCanvasThemeSpec({
      ...spec,
      id: "bad-hud",
      fonts: { ...spec.fonts, hud: "Comic Sans MS" },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join(" ")).toMatch(/fonts\.hud/);
  });
});

describe("hud font bucket — css consumers", () => {
  it.each(HUD_CONSUMERS)("%s reads the token with its previous value as the fallback", (selector) => {
    const rule = cssRule(agentCss, selector);
    // The nested fallback is the whole contract: token absent → --font-mono → generic.
    expect(rule).toMatch(
      /font-family:\s*var\(--canvas-font-hud,\s*var\(--font-mono,[^)]*monospace\)\s*\)/,
    );
  });

  it.each(HUD_CONSUMERS)("%s sets a whole-pixel font-size so a pixel face stays crisp", (selector, px) => {
    const rule = cssRule(agentCss, selector);
    expect(rule).toMatch(new RegExp(`font-size:\\s*${px}px\\s*;`));
  });

  it("never reaches the mono-chrome headers ADR-0033 reserves", () => {
    const terminal = stripCssComments(read("src/styles/canvas/terminal-node.css"));
    const persona = stripCssComments(read("src/styles/canvas/agent-node-persona-nl.css"));
    expect(cssRule(terminal, ".cth-root")).not.toMatch(/--canvas-font-hud/);
    expect(cssRule(persona, ".canvas-persona-header")).not.toMatch(/--canvas-font-hud/);
  });

  it.each(HUD_EXCLUDED)("%s stays on the mono token", (selector) => {
    const rule = cssRule(agentCss, selector);
    expect(rule).not.toMatch(/--canvas-font-hud/);
  });

  it("leaves actual code on the mono token", () => {
    // A fence's LANGUAGE LABEL is metadata and may take the hud face; the code inside it
    // may not. Losing this distinction is how a pixel face ends up rendering a diff.
    expect(cssRule(agentCss, ".agent-md code")).not.toMatch(/--canvas-font-hud/);
    expect(cssRule(agentCss, ".agent-md-codeblock pre code")).not.toMatch(/--canvas-font-hud/);
  });
});
