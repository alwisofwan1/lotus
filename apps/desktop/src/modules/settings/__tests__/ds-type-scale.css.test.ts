import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The app-wide type scale, and the /settings surface that now shares it.
 *
 * Two independent typographic systems used to sit either side of this line. The CodeCanvas
 * settings modal held 70+ distinct `font-size` values in rem; /settings held ~250 arbitrary
 * Tailwind pixel sizes — `text-[10.5px]`, `text-[11.5px]`, `text-[9.5px]` — in px. They shared
 * no value and no vocabulary, so "make the two settings surfaces match" was not a thing anyone
 * could do incrementally.
 *
 * The scale is declared once, at `:root` in design-system.css. A step declared on
 * `.codecanvas-shell` — where this scale started — is invisible to every element outside that
 * shell, even though the root layout now loads `styles/canvas/index.css` on every route.
 *
 * These assertions are blunt on purpose. A vocabulary stays a vocabulary only while adding a
 * word is harder than using one, and the failure mode is never dramatic: it is one careless rule
 * at a time, each individually defensible.
 *
 * WHAT THIS CANNOT SEE: these are text assertions over source. They cannot tell that a token
 * RESOLVES — the exact blind spot that let the `--canvas-font-*` roles go unbridged for months
 * while a test asserted the CSS named them. For the served bundle, run lightningcss over
 * design-system.css and styles/canvas/index.css; for the theme tokens,
 * canvas-theme-var-bridge.css.test.ts covers the declaration side.
 */

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const DS = stripComments(read("src/styles/design-system.css"));
const STEPS = ["micro", "meta", "body", "lede", "head", "display"] as const;

/** Every .tsx under modules/settings, tests excluded. */
function settingsComponents(): string[] {
  const base = resolve(ROOT, "src/modules/settings");
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
  return walk(base);
}

describe("app type scale", () => {
  it("declares exactly six steps at :root, strictly ascending", () => {
    // Strictly ascending is the assertion that carries the weight: a scale with two steps the
    // same size, or one out of order, is a list of numbers wearing a scale's names.
    const sizes = STEPS.map((step) => {
      const m = DS.match(new RegExp(`--ds-t-${step}\\s*:\\s*([0-9.]+)rem\\s*;`));
      expect(m, `--ds-t-${step} is not declared in design-system.css`).not.toBeNull();
      return Number(m?.[1]);
    });
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(STEPS.length);
    expect(
      (DS.match(/--ds-t-[a-z]+\s*:/g) ?? []).length,
      "a seventh step was added — is it earning its place, or is it a size someone did not want to round?",
    ).toBe(STEPS.length);
  });

  it("keeps the floor at or above 11px, where tracked caps stop being mush", () => {
    // The old floors were 6.4px on the canvas and 8px here, with uppercase runs at 8px/0.16em.
    // Tracking that wide makes small caps harder to read, not easier, so the two compounded.
    expect(Number(DS.match(/--ds-t-micro\s*:\s*([0-9.]+)rem/)?.[1]) * 16).toBeGreaterThanOrEqual(11);
  });

  it("exposes every step as a class, sized only", () => {
    for (const step of STEPS) {
      const rule = DS.match(new RegExp(`\\.ds-t-${step}\\s*\\{([^}]*)\\}`));
      expect(rule, `.ds-t-${step} has no class`).not.toBeNull();
      expect(rule?.[1]).toContain(`var(--ds-t-${step})`);
      // A line-height here would beat the `leading-none` that gives a badge its pill height and
      // the `leading-relaxed` that gives a description its measure, because these rules are
      // unlayered and Tailwind's utilities are not.
      expect(rule?.[1], "size only — line-height belongs on the element").not.toMatch(
        /line-height/,
      );
    }
    expect(DS).toMatch(/\.ds-caps\s*\{[^}]*letter-spacing:\s*var\(--ds-tr-caps\)/);
  });

  it("leaves the scale classes unlayered, which is what makes them beat Tailwind", () => {
    // `@import "tailwindcss"` puts every utility in @layer utilities, and unlayered rules beat
    // layered ones regardless of specificity. Wrapping these in a layer would silently hand the
    // win back to any `text-*` that survived the migration — with no visible error.
    expect(DS, "the type-scale classes must not be inside an @layer block").not.toMatch(
      /@layer[^{]*\{[\s\S]*\.ds-t-micro/,
    );
  });
});

describe("the section components in modules/settings consume the scale", () => {
  it("sizes every rule in design-system.css from a step, never a literal", () => {
    const literals = [...DS.matchAll(/font-size:\s*([^;]+);/g)]
      .map((m) => m[1].trim())
      .filter((v) => !v.startsWith("var(--ds-t-"));
    expect(literals, "pick a --ds-t-* step instead of inventing a size").toEqual([]);
  });

  it("uses one tracking value for uppercase runs", () => {
    const offenders: string[] = [];
    for (const m of DS.matchAll(/\{[^{}]*\}/g)) {
      if (!/text-transform:\s*uppercase/.test(m[0])) continue;
      const ls = m[0].match(/letter-spacing:\s*([^;]+);/);
      if (ls && !ls[1].includes("var(--ds-tr-caps)")) offenders.push(ls[1].trim());
    }
    expect(offenders).toEqual([]);
  });

  it("leaves no Tailwind text-size utility in the components", () => {
    // Deliberately a raw scan of the whole file rather than of className attributes: a third of
    // these lived inside `cn("…", cond && "…")` string literals, and a className-only sweep
    // reported itself clean while sixteen sizes sat untouched in exactly the badges and status
    // pills this change was about.
    const offenders: string[] = [];
    for (const file of settingsComponents()) {
      for (const m of read(file.slice(ROOT.length + 1)).matchAll(
        /\btext-(sm|xs|base|lg|xl|\[[0-9.]+px\])/g,
      )) {
        offenders.push(`${file.split("/").pop()}: ${m[0]}`);
      }
    }
    expect(settingsComponents().length, "the walk must still find the section components").toBeGreaterThan(5);
    expect(offenders, "use ds-t-micro / ds-t-meta / ds-t-body / ds-t-lede / ds-t-head").toEqual([]);
  });
});

/**
 * The canvas chrome, and the boundary that stops the scale at the node's edge.
 *
 * React Flow transforms only what `nodeTypes`/`edgeTypes` render, so a node's text is scaled by
 * the user's zoom and a fixed px floor says nothing useful about it. Everything OUTSIDE that
 * transform — panels, modals, rails, sheets, toolbars — is read at 1:1 and takes the scale.
 *
 * The files below contain no node-owned selectors at all, so they are held to zero literals.
 * Files that mix the two (agent-node-graph.css holds the Fleet panel AND card internals) cannot
 * be asserted this way and are covered by the per-declaration classification instead.
 */
describe("canvas chrome consumes the scale", () => {
  const CHROME_ONLY = [
    "panels-collab.css",
    "panels-picker.css",
    "layout-panels.css",
    "layout.css",
    "gallery.css",
    "canvas-command-sheet.css",
    "agent-completion-toast.css",
    "voice-tool-trace.css",
    "sphere.css",
  ] as const;

  it.each(CHROME_ONLY.map((f) => [f] as const))("%s sizes every rule from a step", (file) => {
    const css = stripComments(read(`src/styles/canvas/${file}`));
    const literals = [...css.matchAll(/font-size:\s*([^;]+);/g)]
      .map((m) => m[1].trim())
      .filter((v) => !v.startsWith("var("));
    expect(literals, `pick a --ds-t-* step in ${file}`).toEqual([]);
  });

  it("keeps the documented exemptions, so nothing quietly folds them in later", () => {
    // Each of these is load-bearing for something other than reading comfort. They are the
    // reason this migration is per-declaration rather than a search-and-replace.
    const canvasCss = ["agent-node.css", "music-node.css", "canvases-modal.css", "note-node.css"]
      .map((f) => stripComments(read(`src/styles/canvas/${f}`)))
      .join("\n");
    // A pixel face rendered at a fractional size is mush, so the hud register keeps whole px.
    expect(canvasCss).toMatch(/font-size:\s*\d+px/);
    // Fluid sizes in the music node and the canvases modal stay fluid.
    expect(canvasCss).toMatch(/font-size:\s*clamp\(/);
    // Note headings are `em`, which is how node content follows --canvas-node-text-size.
    expect(canvasCss).toMatch(/font-size:\s*[\d.]+em;/);
  });
});
