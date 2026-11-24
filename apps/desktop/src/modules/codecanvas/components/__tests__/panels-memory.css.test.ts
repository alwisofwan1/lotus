import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const raw = readFileSync(resolve(process.cwd(), "src/styles/canvas/panels-memory.css"), "utf8");

/** Comments talk about the banned properties on purpose, so strip them before asserting. */
function stripCssComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, "");
}

const css = stripCssComments(raw);

function rule(openingSelector: string): string {
  const start = css.indexOf(openingSelector);
  expect(start, `selector not found: ${openingSelector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

describe("panels-memory.css (project memory surface)", () => {
  it("never blurs: backdrop-filter over the canvas costs frames on every pan", () => {
    expect(css).not.toMatch(/backdrop-filter\s*:/);
    expect(css).not.toMatch(/-webkit-backdrop-filter\s*:/);
  });

  it("pins an opaque hex on background-color so no theme can make the panel see-through", () => {
    const shell = rule(".canvas-memory-shell {");
    expect(shell).toMatch(/background-color:\s*#[0-9a-fA-F]{6}\s*;/);
    // --canvas-bg / --canvas-surface bleed toward zero alpha in image themes: that was the bug.
    expect(shell).not.toMatch(/background(-color)?:[^;]*--canvas-bg/);
    expect(shell).not.toMatch(/background(-color)?:[^;]*--canvas-surface\b/);
  });

  it("carries theme colour through --canvas-surface-r, which is always a valid rgba", () => {
    expect(rule(".canvas-memory-shell {")).toMatch(/background-image:[\s\S]*--canvas-surface-r/);
  });

  it("derives kind colour from the theme-independent status ramp, never from --canvas-accent", () => {
    const shell = rule(".canvas-memory-shell {");
    expect(shell).toMatch(/--cc-mem-rule:\s*var\(--canvas-status-blocked/);
    expect(shell).toMatch(/--cc-mem-decision:\s*var\(--canvas-status-completed/);
    expect(shell).toMatch(/--cc-mem-blocker:\s*var\(--canvas-status-error/);
    // --canvas-accent resolves to a near-white in every builtin theme, so it carries no signal.
    expect(shell).not.toMatch(/--cc-mem-[a-z]+:\s*var\(--canvas-accent/);
  });

  it("keeps memory prose at a readable size, above the old 0.72rem/1.35", () => {
    const body = rule(".canvas-memory-item-body {");
    const height = Number(/line-height:\s*([\d.]+)/.exec(body)?.[1]);
    expect(height).toBeGreaterThanOrEqual(1.5);

    // The size now comes from the shared type scale, so resolve the step rather than reading a
    // literal. This assertion used to parse `([\d.]+)rem` straight out of the rule; after the
    // migration that matched nothing, `Number(undefined)` was NaN, and `NaN > 0.75` is false —
    // the test failed while the CSS had actually got BIGGER (0.795rem → the 13px body step).
    // A guard that cannot read the value it guards is worse than no guard, because it fails on
    // the refactor and passes on the regression.
    const step = /font-size:\s*var\(--(ds-t-[a-z]+)\)/.exec(body)?.[1];
    expect(step, "memory prose must take a step from the shared scale").toBeDefined();
    const ds = readFileSync(resolve(process.cwd(), "src/styles/design-system.css"), "utf8");
    const rem = Number(new RegExp(`--${step}:\\s*([0-9.]+)rem`).exec(ds)?.[1]);
    expect(rem, `--${step} is not declared in design-system.css`).toBeGreaterThan(0);
    // Memory rows are prose, not chrome metadata: they sit on the reading side of the scale.
    expect(rem).toBeGreaterThan(0.75);
  });

  it("clamps only when asked, so an expanded row can show its whole body", () => {
    expect(css).toMatch(/\.canvas-memory-item-body\[data-clamped="true"\]/);
    expect(rule(".canvas-memory-item-body {")).not.toMatch(/-webkit-line-clamp/);
  });

  it("caps the reading measure in the expanded view", () => {
    expect(rule('.canvas-memory-shell[data-expanded="true"] .canvas-memory-item-body {')).toMatch(/max-width:\s*65ch/);
  });

  it("hides row actions until hover or focus so archive is not a permanent one-click", () => {
    const actions = rule(".canvas-memory-item-actions {");
    expect(actions).toMatch(/opacity:\s*0\s*;/);
    expect(css).toMatch(/\.canvas-memory-item:hover \.canvas-memory-item-actions/);
    expect(css).toMatch(/\.canvas-memory-item:focus-within \.canvas-memory-item-actions/);
  });

  it("respects reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
