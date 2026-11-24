import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every floating surface in the app is elevation 3 (PLAN app-theme-dark-light-premium §4.5,
 * mockup 10 decision T7): the overlay step, the popover border and the popover shadow, all from the
 * `--ds-workbench-popover-*` set, with no backdrop blur. One set of tokens means a menu in Tasks
 * and a menu in the editor lift by the same amount, and a theme change reaches both.
 *
 * Canvas (src/styles/canvas/), codespace.css and the CodeChat section of globals.css route their
 * own floating surfaces; this list is the rest of app CSS.
 */

const ROOT = process.cwd();

const SURFACES: Record<string, string[]> = {
  "src/app/globals.css": [
    ".codespace-workbench-breadcrumb-menu",
    ".codespace-selection-popover",
    ".codespace-context-menu",
    ".source-repo-branch-popover",
    ".glass-dropdown",
    ".codechat-popover-surface",
  ],
  "src/styles/resource-kit.css": [".rs-menu-content"],
  "src/styles/workspace-shell.css": [".ws-menu"],
  "src/styles/tasks.css": [".tk-chip-menu", ".tk-prop-menu", ".tk-delegate-menu", ".tk-pick-pop"],
  "src/styles/factory.css": [".fa-picker"],
  "src/styles/jump-palette.css": [".jp"],
};

/** Variants of a surface that may change its size and shape, never its elevation. */
const VARIANTS: Record<string, string[]> = {
  "src/styles/automation.css": ['.au-shell[data-variant="dock"] .rs-menu-content'],
};

const PAINT = ["background", "background-color", "border", "border-color", "box-shadow", "backdrop-filter"];

/** The declarations of the rule whose selector list is exactly `selector`. */
function declarations(file: string, selector: string): Map<string, string> {
  const css = readFileSync(resolve(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.search(new RegExp(`(^|\\n|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`));
  expect(start, `${selector} in ${file}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start + 1);
  const body = css.slice(open + 1, css.indexOf("}", open));
  return new Map(
    body
      .split(";")
      .map((decl) => decl.trim())
      .filter(Boolean)
      .map((decl) => {
        const colon = decl.indexOf(":");
        return [decl.slice(0, colon).trim(), decl.slice(colon + 1).replace(/\s+/g, " ").trim()] as const;
      }),
  );
}

const surfaces = Object.entries(SURFACES).flatMap(([file, selectors]) => selectors.map((s) => [file, s] as const));
const variants = Object.entries(VARIANTS).flatMap(([file, selectors]) => selectors.map((s) => [file, s] as const));

describe("app popover surfaces", () => {
  it.each(surfaces)("%s %s is elevation 3 from the popover tokens", (file, selector) => {
    const rule = declarations(file, selector);
    expect(rule.get("background")).toBe("var(--ds-workbench-popover-bg)");
    expect(rule.get("border")).toBe("1px solid var(--ds-workbench-popover-border)");
    expect(rule.get("box-shadow")).toBe("var(--ds-workbench-popover-shadow)");
    expect(rule.has("backdrop-filter")).toBe(false);
    expect(rule.has("-webkit-backdrop-filter")).toBe(false);
  });

  it.each(variants)("%s %s keeps the elevation it varies", (file, selector) => {
    const rule = declarations(file, selector);
    expect(PAINT.filter((property) => rule.has(property))).toEqual([]);
  });

  it.each(surfaces)("%s %s has no light-mode repaint: the tokens already follow the mode", (file, selector) => {
    const css = readFileSync(resolve(ROOT, file), "utf8");
    expect(css).not.toContain(`[data-theme-type="light"] ${selector} {`);
  });
});
