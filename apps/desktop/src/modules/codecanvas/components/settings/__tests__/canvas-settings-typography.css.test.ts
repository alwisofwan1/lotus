import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Canvas Settings type scale, and the guard that keeps it a scale.
 *
 * Before this, `styles/canvas/*.css` held 70+ distinct `font-size` values — including runs like
 * 0.615 / 0.62 / 0.625 / 0.63 / 0.64rem, differences no one can see but that guarantee no two
 * surfaces share a baseline. Nothing was wrong with any single value; the problem was that each
 * one was an independent decision, so the seventy-first was always one commit away.
 *
 * A vocabulary only stays a vocabulary if adding a word is harder than using one. That is what
 * these assertions are for. They are cheap and blunt on purpose: a literal size, a stray Tailwind
 * text utility, or a seventh step all go red immediately, and the fix is always "pick a step".
 *
 * WHAT THIS CANNOT SEE, so nobody mistakes a green run for proof of rendering: these are text
 * assertions over stylesheets. They cannot tell that a token RESOLVES — the whole reason the
 * `--canvas-font-*` roles went unbridged for months while a test asserted the CSS named them.
 * That half is covered by canvas-theme-var-bridge.css.test.ts (every token has a declaration)
 * and, for the served bundle, by running lightningcss over `styles/canvas/index.css`.
 */

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The four stylesheets that dress the settings modal. */
const SHEETS = [
  "src/styles/canvas/settings-modal.css",
  "src/styles/canvas/settings-modal-style.css",
  "src/styles/canvas/settings-modal-tabs.css",
  "src/styles/canvas/settings-modal-templates.css",
] as const;

const SETTINGS_CSS = SHEETS.map((f) => [f, stripComments(read(f))] as const);
/* The scale itself lives at :root in design-system.css and is guarded by
   src/modules/settings/__tests__/ds-type-scale.css.test.ts — six ascending steps, the 11px
   floor, and the .ds-t-* classes. This file only asserts that the canvas settings sheets
   CONSUME it, which is the half that can regress one careless rule at a time. */
const THEME_CSS = stripComments(read("src/styles/canvas/theme.css"));

describe("settings modal type scale", () => {
  it("keeps the scale out of theme.css, where /settings could never reach it", () => {
    // A step declared on .codecanvas-shell is invisible to /settings, which renders outside that
    // shell, so a re-declaration here would silently
    // fork the scale in two — the exact split this work existed to close.
    expect(THEME_CSS, "the scale belongs at :root in design-system.css").not.toMatch(
      /--ds-t-[a-z]+\s*:/,
    );
  });

  it.each(SETTINGS_CSS)("%s sizes every rule from the scale, never a literal", (_file, css) => {
    const literals = [...css.matchAll(/font-size:\s*([^;]+);/g)]
      .map((m) => m[1].trim())
      .filter((v) => !v.startsWith("var(--ds-t-"));
    expect(literals, "pick a --ds-t-* step instead of inventing a size").toEqual([]);
  });

  it.each(SETTINGS_CSS)("%s uses one tracking value for uppercase runs", (_file, css) => {
    // The four sheets previously spread 0.02em-0.16em across the same job, and the widest
    // values sat on the smallest text.
    const offenders: string[] = [];
    for (const m of css.matchAll(/\{[^{}]*\}/g)) {
      const rule = m[0];
      if (!/text-transform:\s*uppercase/.test(rule)) continue;
      const ls = rule.match(/letter-spacing:\s*([^;]+);/);
      if (ls && !ls[1].includes("var(--ds-tr-caps)")) offenders.push(ls[1].trim());
    }
    expect(offenders).toEqual([]);
  });

  it("does not keep a second copy of the type-scale classes", () => {
    // .ds-t-* and .ds-caps are declared once, in design-system.css. They lived here briefly,
    // scoped under .canvas-settings-surface to win against Tailwind by specificity — which
    // worked, and was reasoning about the wrong mechanism: Tailwind utilities sit in
    // @layer utilities, and any unlayered rule beats them however plain its selector.
    expect(SETTINGS_CSS[0][1]).not.toMatch(/\.ds-t-(micro|meta|body|lede|display)\s*\{/);
  });

  it("leaves no Tailwind text-size utility in the settings components", () => {
    // Two authoring surfaces for one scale means every change has to be made twice, and in
    // practice was only ever made once. Arbitrary values (`text-[0.6875rem]`) are the worst of
    // it: they are literals that no stylesheet search will ever surface.
    const dir = resolve(ROOT, "src/modules/codecanvas/components/settings");
    const frame = resolve(ROOT, "src/modules/lotus-settings/components");
    const files = [
      ...readdirSync(frame).map((f) => `${frame}/${f}`),
      ...readdirSync(`${dir}/tabs`).map((f) => `${dir}/tabs/${f}`),
    ].filter((f) => f.endsWith(".tsx"));
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /\btext-(sm|xs|base|lg|xl|\[[^\]]+\])/g,
      )) {
        offenders.push(`${file.split("/").pop()}: ${m[0]}`);
      }
    }
    expect(offenders, "use ds-t-micro / ds-t-meta / ds-t-body / ds-t-lede").toEqual([]);
  });

  it("gives the modal surface the app's own face, not the canvas theme's", () => {
    // Graphite (2026-11-07): Settings is app chrome, so it keeps one face on every canvas theme.
    const surface = SETTINGS_CSS[0][1].match(/\.canvas-settings-surface\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(surface).toMatch(/font-family:\s*'Inter'/);
    expect(surface).not.toMatch(/font-family:\s*var\(--canvas-font-body/);
  });
});

/**
 * Two failures that shared one shape: a control's appearance was decided at the call site, using
 * an assumption that only held on some themes.
 *
 * `--cc-well` derived the input recess from `--canvas-bg`, which is `paper.fill` — a GRADIENT on
 * six of the seven built-in themes. color-mix() with a gradient is invalid at computed-value time,
 * so the declaration produced nothing and the field painted `rgba(0,0,0,0)`. Verified in a browser
 * on all seven themes, because the failure is silent: a field with no well looks like a design
 * choice, not a bug.
 *
 * Five other controls skipped the token entirely and hardcoded `bg-black/25`, which is the
 * dark-theme assumption `SettingSegmentedRow` already had a comment warning about — a black slot
 * punched into pale paper on Garden of Dawn.
 */
describe("settings controls survive every theme", () => {
  const modal = stripComments(read("src/styles/canvas/settings-modal.css"));

  const componentFiles = (): string[] => {
    const dirs = ["src/modules/codecanvas/components/settings", "src/modules/lotus-settings/components"];
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.name === "__tests__"
          ? []
          : e.isDirectory()
            ? walk(`${d}/${e.name}`)
            : e.name.endsWith(".tsx")
              ? [`${d}/${e.name}`]
              : [],
      );
    return dirs.flatMap((d) => walk(resolve(ROOT, d)));
  };

  it("never mixes a colour with --canvas-bg, which is a gradient on six of seven themes", () => {
    const offenders = [...modal.matchAll(/color-mix\([^;]*--canvas-bg[^;]*\)/g)].map((m) => m[0]);
    expect(offenders, "derive from the theme's ink or surface, never from paper.fill").toEqual([]);
    // And the recess must still exist, or this passes by having deleted the feature.
    expect(modal).toMatch(/--cc-well:\s*color-mix\([^;]*--cc-ink-src/);
  });

  it("has no hardcoded black or white surfaces in the components", () => {
    // MobileTab's QR quiet zone is the one legitimate white, and it is a plain `bg-white` on a
    // container rather than a translucent surface tint, so it does not match this shape.
    const offenders: string[] = [];
    for (const f of componentFiles()) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bbg-(black|white)\/\d+/g)) {
        offenders.push(`${f.split("/").pop()}: ${m[0]}`);
      }
    }
    expect(offenders, "use --cc-well / an ink mix so the surface follows the theme").toEqual([]);
  });

  it("gives every focusable control in the panel a visible ring", () => {
    // ~52 interactive elements across 19 components had two focus styles between them, and
    // eleven removed the browser's default with `outline-none` and put nothing back (WCAG 2.4.7).
    expect(modal).toMatch(
      /\.canvas-settings-surface\s+:is\([^)]*button[^)]*input[^)]*\):focus-visible\s*\{[^}]*outline:/,
    );
    const offenders = componentFiles().filter((f) => /\boutline-none\b/.test(readFileSync(f, "utf8")));
    expect(
      offenders.map((f) => f.split("/").pop()),
      "focus is owned by settings-modal.css; a call site should not suppress it",
    ).toEqual([]);
  });
});
