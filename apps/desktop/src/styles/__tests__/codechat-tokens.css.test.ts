import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { countColorLiterals } from "./color-literals";

/**
 * CodeChat paints from the design system (PLAN app-theme-dark-light-premium §4.3, Theme 14).
 *
 * The `--codechat-*` tokens used to be relative-colour mixes of `--fg` in Dark and slate rgba()
 * literals in Light, so Light CodeChat was cool grey on a warm app. Each token now names a
 * design-system token (or another CodeChat token), and both themes come out of the same
 * declaration because the design-system tokens already differ per theme.
 */

const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every innermost `selector { body }` block, so rules inside @media are found too. */
function rules(): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

function codechatDeclarations(): [string, string][] {
  return [...css.matchAll(/(--codechat-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);
}

describe("CodeChat tokens", () => {
  it("declares each --codechat-* token once, for both themes", () => {
    const names = codechatDeclarations().map(([name]) => name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it("derives every --codechat-* token from a token, never a colour literal", () => {
    const offenders = codechatDeclarations().filter(
      ([, value]) => countColorLiterals(value).count > 0 || !/var\(--(ds-|bubble-|codechat-)/.test(value),
    );
    expect(offenders).toEqual([]);
  });

  it("paints CodeChat rules without colour literals", () => {
    const offenders = rules()
      .filter(({ selector }) => selector.includes(".codechat-"))
      .filter(({ body }) => countColorLiterals(body).count > 0)
      .map(({ selector }) => selector);
    expect(offenders).toEqual([]);
  });
});
