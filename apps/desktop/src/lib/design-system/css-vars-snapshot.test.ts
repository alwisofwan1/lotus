import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DESIGN_THEME_MODES, getDesignTheme, getDesignThemeCssVars } from "@/lib/design-system";

// Every CSS variable each theme emits, recorded before Theme 03 moved the theme-specific literals
// out of getDesignThemeCssVars and into the palettes. A palette change shows up here as a diff to
// review; update the files with `vitest -u` only when that change is intended.
describe("design theme CSS variables", () => {
  it.each(DESIGN_THEME_MODES)("%s emits the recorded variables", async (mode) => {
    const vars = getDesignThemeCssVars(getDesignTheme(mode));
    await expect(`${JSON.stringify(vars, null, 2)}\n`).toMatchFileSnapshot(
      `./__snapshots__/css-vars.${mode}.json`,
    );
  });

  it("are derived from the palette alone, with no colour written for one theme", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/design-system/resolve-theme.ts"), "utf8");
    const builder = source.slice(source.indexOf("export function getDesignThemeCssVars"));
    expect(builder).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(builder).not.toMatch(/rgba?\(/);
    expect(builder).not.toMatch(/isLight|theme\.type/);
  });
});
