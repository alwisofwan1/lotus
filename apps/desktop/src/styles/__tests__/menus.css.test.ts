import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One look for every floating menu (2026-10-25). The corner, the inset, the row and the hover are
 * tokens on :root in design-system.css (`--ds-menu-*`); each family's own stylesheet reads them
 * and sets none of its own. Before this, four families had three corners, three row paddings,
 * three hover colours and three entrances.
 *
 * Canvas menus are out of scope: Canvas themes own their palette (src/styles/canvas/).
 */

const ROOT = process.cwd();
const FILES = [
  "src/styles/resource-kit.css",
  "src/styles/workspace-shell.css",
  "src/styles/tasks.css",
  "src/styles/automation.css",
  "src/app/globals.css",
];

const SURFACES = [".rs-menu-content", ".ws-menu", ".tk-chip-menu", ".tk-prop-menu", ".glass-dropdown"];
const ROWS = [".rs-menu-item", ".ws-menu-item", ".ws-menu-preset", ".tk-chip-option", ".tk-fr-option", ".codechat-menu-item", ".glass-dropdown-item"];

type Rule = { file: string; selectors: string[]; body: string };

function rules(): Rule[] {
  return FILES.flatMap((file) => {
    const css = readFileSync(resolve(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    return [...css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].map((match) => ({
      file,
      selectors: match[1].split(",").map((selector) => selector.trim()),
      body: match[2],
    }));
  });
}

/** The class the rule styles: its last compound, before any pseudo-element. */
const subjectHas = (selector: string, cls: string) => {
  const last = selector.split(/\s*[\s>+~]\s*/).pop() ?? "";
  return new RegExp(`${cls.replace(".", "\\.")}(?![\\w-])`).test(last.split("::")[0]) && !last.includes("::");
};

const ruleFor = (selector: string) => rules().filter((rule) => rule.selectors.includes(selector));

describe("menus share one look", () => {
  it.each(SURFACES)("%s uses the shared corner and entrance", (selector) => {
    const body = ruleFor(selector).map((rule) => rule.body).join("\n");
    expect(body).toContain("border-radius: var(--ds-menu-radius)");
    expect(body).toContain("animation: var(--ds-menu-in)");
  });

  it("gives the chat composer's menus the same corner and entrance", () => {
    const body = ruleFor(".codechat-popover-surface:has(.codechat-menu-item)").map((rule) => rule.body).join("\n");
    expect(body).toContain("border-radius: var(--ds-menu-radius)");
    expect(body).toContain("animation: var(--ds-menu-in)");
  });

  it("lets no family set a corner of its own on a menu or a row", () => {
    const offenders = rules().flatMap((rule) =>
      rule.selectors
        .filter((selector) => [...SURFACES, ...ROWS].some((cls) => subjectHas(selector, cls)))
        .filter(() => /border-radius:/.test(rule.body) && !/border-radius:\s*var\(--ds-menu-/.test(rule.body))
        .map((selector) => `${rule.file}: ${selector}`),
    );
    expect(offenders).toEqual([]);
  });

  it("hovers every row in the shared hover", () => {
    const hovers = rules().flatMap((rule) =>
      rule.selectors
        .filter((selector) => ROWS.some((cls) => selector.includes(`${cls}:hover`)))
        .filter((selector) => !selector.includes("danger"))
        .filter(() => /(^|[\s;])background:/.test(rule.body))
        .map((selector) => ({ selector, body: rule.body })),
    );
    expect(hovers.length).toBeGreaterThan(0);
    expect(hovers.filter(({ body }) => !body.includes("var(--ds-menu-hover)")).map(({ selector }) => selector)).toEqual([]);
  });
});
