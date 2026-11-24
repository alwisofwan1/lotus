import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The listening-border FX is CSS-driven (spectrum written to custom props by the component), so its
 * key invariants live in the stylesheet, not the DOM. These assertions lock the load-bearing rules —
 * several encode hard-won WKWebView constraints (see the stylesheet header): a regression here silently
 * breaks the effect in the desktop app while every DOM test stays green.
 */
const css = readFileSync(resolve(process.cwd(), "src/styles/canvas/canvas-nl-listening-fx.css"), "utf8");
const index = readFileSync(resolve(process.cwd(), "src/styles/canvas/index.css"), "utf8");

describe("canvas-nl-listening-fx.css", () => {
  it("is imported into the canvas stylesheet bundle", () => {
    expect(index).toContain("canvas-nl-listening-fx.css");
  });

  it("shows the FX only while a voice state is active", () => {
    expect(css).toMatch(/\.canvas-nl-fx\s*\{[^}]*opacity:\s*0/);
    expect(css).toContain(".canvas-nl-input-row[data-voice] .canvas-nl-fx");
  });

  it("paints the spectrum directly on the masked ring, with a drift fallback so the frame is never dead", () => {
    // WKWebView: composited children inside masked parents break — the ring must be a single element
    // whose background IS the gradient (no nested rotor, no transform animation on it).
    const ring = css.slice(css.indexOf(".canvas-nl-fx-ring {"), css.indexOf(".canvas-nl-fx-halo {"));
    expect(ring).toContain("--nl-spectrum");
    expect(ring).toContain("conic-gradient(");
    expect(css).not.toContain(".canvas-nl-fx-rotor"); // the nested-rotor architecture must not return
    expect(ring).not.toMatch(/\banimation\s*:/);
    expect(ring).not.toMatch(/\btransform\s*:/);
  });

  it("keys its hue off the theme's vivid wire accent, never the near-white chrome accent", () => {
    // The chrome/text accent tokens resolve to #f5f2ef (near-white) in every built-in theme →
    // invisible as a thin border. The vivid per-theme color is the wire accent (palette.accent).
    expect(css).toContain("--nl-fx-accent: var(--canvas-wire-active, #22d3ee)");
    expect(css).not.toContain("ct-canvas-accent");
  });

  it("declares mask composites AFTER the mask shorthands (WKWebView resets composite on shorthand)", () => {
    const ring = css.slice(css.indexOf(".canvas-nl-fx-ring {"), css.indexOf(".canvas-nl-fx-halo {"));
    const lastShorthand = Math.max(ring.indexOf("\n  mask:"), ring.indexOf("-webkit-mask:"));
    const firstComposite = Math.min(ring.indexOf("mask-composite:"), ring.indexOf("-webkit-mask-composite:"));
    expect(lastShorthand).toBeGreaterThan(-1);
    expect(firstComposite).toBeGreaterThan(lastShorthand);
  });

  it("keeps the halo unmasked and filter-free glow via box-shadow (mask+filter combos break in WKWebView)", () => {
    const halo = css.slice(css.indexOf(".canvas-nl-fx-halo {"), css.indexOf("[data-voice=\"recording\"] .canvas-nl-fx-halo"));
    expect(halo).toContain("box-shadow");
    expect(halo).not.toMatch(/[-a-z]*mask[-a-z]*\s*:/); // no mask declarations of any form
    expect(halo).not.toMatch(/\bfilter\s*:/);
  });

  it("masks only a border band and adds no backdrop-filter, keeping the docked dropdown-blur fix intact", () => {
    expect(css).toContain("mask-composite: exclude");
    expect(css).toContain("pointer-events: none");
    expect(css).not.toContain("backdrop-filter");
  });

  it("holds a static tint under prefers-reduced-motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/animation:\s*none/);
  });

  it("gives the ring a low opacity floor so silence and loud speech read as genuinely different states (E)", () => {
    const ring = css.slice(css.indexOf(".canvas-nl-fx-ring {"), css.indexOf(".canvas-nl-fx-halo {"));
    const m = ring.match(/opacity:\s*calc\(([\d.]+)\s*\+/);
    expect(m).not.toBeNull();
    expect(parseFloat(m![1])).toBeLessThan(0.7); // old floor (0.85) barely dimmed at rest — too flat
  });

  it("threads the onset pulse into the ring's brightness and the halo's box-shadow size (D)", () => {
    const ring = css.slice(css.indexOf(".canvas-nl-fx-ring {"), css.indexOf(".canvas-nl-fx-halo {"));
    expect(ring).toContain("--nl-onset");
    const halo = css.slice(css.indexOf(".canvas-nl-fx-halo {"), css.indexOf("[data-voice=\"recording\"] .canvas-nl-fx-halo"));
    expect(halo).toMatch(/box-shadow:[\s\S]*var\(--nl-onset/);
  });

  it("anchors the static fallback gradient's brightest point at the mic side, consistent with the live spectrum (C)", () => {
    const ring = css.slice(css.indexOf(".canvas-nl-fx-ring {"), css.indexOf(".canvas-nl-fx-halo {"));
    // The live gradient's `from` is anchorDeg(90) - 180 = -90deg; the hand-authored fallback must match
    // so the resting look and the live look agree on where the light originates.
    expect(ring).toMatch(/var\(\s*\n\s*--nl-spectrum,\s*\n\s*conic-gradient\(\s*\n\s*from -90deg/);
  });
});
