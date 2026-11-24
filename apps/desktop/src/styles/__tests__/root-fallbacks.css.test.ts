import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import dark from "@/lib/design-system/__snapshots__/css-vars.dark.json";
import { countColorLiterals } from "./color-literals";

/**
 * The `:root` values the app paints with before the theme reaches the page (Theme 15).
 *
 * theme-bootstrap writes every palette variable inline on <html> before first paint, so these
 * only show if that script fails. They used to be the retired Void theme (#060609 grounds, cool
 * greys), so a failed bootstrap painted a theme that no longer exists. Now the palette aliases in
 * globals.css read the design-system tokens, and design-system.css holds the one copy of literal
 * fallbacks, which must be the Dark palette exactly.
 */
const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) =>
    c.startsWith("/* color-literal-ok:") ? c : "",
  );
const firstRoot = (css: string) => css.match(/^:root \{[^}]*\}/m)?.[0] ?? "";
const declarations = (block: string) =>
  Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const normalize = (value: string) => value.replace(/\s+/g, "").replace(/,/g, ", ").toLowerCase();

describe(":root fallbacks", () => {
  it("globals.css aliases the palette variables to design-system tokens, with no literal", () => {
    const root = firstRoot(read("src/app/globals.css"));
    const vars = declarations(root);
    for (const name of ["--bg", "--bg-sidebar", "--bg-card", "--bg-elevated", "--fg", "--accent", "--border"]) {
      expect(vars[name], name).toMatch(/var\(--ds-/);
    }
    expect(countColorLiterals(root.replace(/\/\*[\s\S]*?\*\//g, "")).count).toBe(0);
  });

  it("design-system.css falls back to the Dark palette, value for value", () => {
    const vars = declarations(firstRoot(read("src/styles/design-system.css")));
    const colours = Object.entries(vars).filter(([, v]) => /#|rgba?\(/.test(v));
    expect(colours.length).toBeGreaterThan(10);
    for (const [name, value] of colours) {
      expect(normalize(value), name).toBe(normalize(String((dark as Record<string, string>)[name])));
    }
  });

  it("design-system.css carries the popover surface, so a failed bootstrap leaves menus filled", () => {
    const vars = declarations(firstRoot(read("src/styles/design-system.css")));
    for (const name of [
      "--ds-workbench-popover-bg",
      "--ds-workbench-popover-border",
      "--ds-workbench-popover-shadow",
    ]) {
      expect(vars[name], name).toBeDefined();
    }
  });

  it("design-system.css declares every token globals.css aliases to", () => {
    const ds = declarations(firstRoot(read("src/styles/design-system.css")));
    const root = firstRoot(read("src/app/globals.css"));
    const used = new Set([...root.matchAll(/var\((--ds-[\w-]+)/g)].map((m) => m[1]));
    expect([...used].filter((name) => !(name in ds))).toEqual([]);
  });
});
