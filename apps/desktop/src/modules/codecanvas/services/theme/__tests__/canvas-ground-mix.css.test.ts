import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import glob from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "../builtin-themes";
import { resolveCanvasTheme } from "../resolve-canvas-theme";

/**
 * Never color-mix() from `--canvas-bg`.
 *
 * That token is `paper.fill`. It is a flat colour on exactly one built-in theme (Void, #050506)
 * and a GRADIENT on the other six. color-mix() with a gradient is invalid at computed-value time,
 * so the whole declaration is dropped and the element paints nothing — measured in a browser
 * across all seven themes: `rgba(0, 0, 0, 0)` on six, correct on Void.
 *
 * This is not a hypothetical. Thirteen declarations shipped it: ten in the collaboration panel
 * (its thread, header, task cards and composer had no background at all on six themes), three in
 * the Fleet panel's selected-row recess, one in the terminal header's rename field. And the trap
 * was already written down — `note-node.css` has carried a comment warning about exactly this for
 * some time. A comment protects whoever reads that file; a test protects everyone else, which is
 * the only reason this exists as code rather than as another paragraph.
 *
 * WHAT TO USE INSTEAD: `--node-floor-solid`. It is the same ground resolved as an opaque colour on
 * every theme, which is what these declarations meant by "the ground the panel floats above". On
 * Void it is rgb(9,9,14) against paper.fill's #050506, so an existing look survives the swap to
 * within a rounding error.
 *
 * `--canvas-bg` remains correct as a plain `background` value, where a gradient is the point.
 */

const CANVAS_DIR = "src/styles/canvas";

function canvasStylesheets(): string[] {
  return glob
    .readdirSync(resolve(process.cwd(), CANVAS_DIR))
    .filter((f) => f.endsWith(".css"))
    .sort();
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("canvas ground mixing", () => {
  const sheets = canvasStylesheets();

  it("finds the stylesheets at all, so the sweep cannot pass vacuously", () => {
    expect(sheets.length).toBeGreaterThan(20);
  });

  it.each(sheets.map((f) => [f] as const))("%s never mixes a colour with --canvas-bg", (file) => {
    const css = stripComments(readFileSync(resolve(process.cwd(), CANVAS_DIR, file), "utf8"));
    const offenders = [...css.matchAll(/color-mix\([^;]*?--canvas-bg[^;]*?\)/g)].map((m) => m[0]);
    expect(
      offenders,
      "use --node-floor-solid: --canvas-bg is paper.fill, a gradient on six of seven themes",
    ).toEqual([]);
  });

  it("keeps --node-floor-solid a flat colour on every built-in, or the advice above is wrong", () => {
    // The whole recommendation rests on this. If a theme ever resolves a floor that is not a
    // plain colour, every declaration this test redirected would break the same silent way.
    for (const theme of BUILTIN_THEMES) {
      const floor = (resolveCanvasTheme(theme) as Record<string, string>)["--node-floor-solid"];
      expect(floor, `${theme.id} emits no floor`).toBeDefined();
      expect(
        floor,
        `${theme.id}: --node-floor-solid must be a plain colour, got "${floor}"`,
      ).toMatch(/^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|oklab\(|oklch\()/);
    }
  });

  it("still lets --canvas-bg be used as a plain background, where a gradient is the point", () => {
    // Guards against over-correcting: this rule is about color-mix(), not about the token.
    const all = sheets
      .map((f) => stripComments(readFileSync(resolve(process.cwd(), CANVAS_DIR, f), "utf8")))
      .join("\n");
    expect(all).toMatch(/background(-image)?:\s*[^;]*var\(--canvas-bg/);
  });
});
