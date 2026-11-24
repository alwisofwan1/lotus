import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles/canvas/canvas-nl-bar.css"), "utf8");
const index = readFileSync(resolve(process.cwd(), "src/styles/canvas/index.css"), "utf8");

/** Slice out a single (unnested) ruleset by its opening-selector text, up to its closing `}`. Works
 *  for both single-line (`sel { decl; }`) and multi-line rules since none of these are nested. */
function rule(openingSelector: string): string {
  const start = css.indexOf(openingSelector);
  expect(start, `selector not found: ${openingSelector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

describe("canvas-nl-bar.css (NL command bar revamp — material + geometry)", () => {
  it("never lets the target chip column shrink under the chip, so typing cannot land on it", () => {
    // An `auto` track shrank to 39px for a 109px "→ Lotus · auto" on a narrow row; the text column gives instead.
    expect(rule('.canvas-nl-input-row[data-target="true"] {')).toMatch(/grid-template-columns:\s*max-content minmax\(0, 1fr\);/);
  });

  it("is imported into the canvas stylesheet bundle, after the base NL bar CSS", () => {
    expect(index).toContain("canvas-nl-bar.css");
    expect(index.indexOf("agent-node-persona-nl.css")).toBeLessThan(index.indexOf("canvas-nl-bar.css"));
  });

  it("animates the words cascade with transform + opacity only, never filter", () => {
    // A filter repaint on persistent chrome is the exact cost class canvas-surface-performance
    // .css.test.ts already bans; the per-word stagger has to carry the effect without it.
    const word = rule(".canvas-nl-hint-word {");
    expect(word).toMatch(/transition:\s*transform[\s\S]*opacity/);
    expect(word).not.toMatch(/\bfilter\s*:/);
    const out = rule('.canvas-nl-hint-line[data-phase="out"] .canvas-nl-hint-word');
    const inn = rule('.canvas-nl-hint-line[data-phase="in"]  .canvas-nl-hint-word');
    const hold = rule('.canvas-nl-hint-line[data-phase="hold"] .canvas-nl-hint-word');
    for (const block of [word, out, inn, hold]) {
      expect(block).not.toMatch(/\bfilter\s*:/);
    }
  });

  // REMOVED with the element: there used to be a test here pinning that .canvas-nl-keys collapsed by
  // max-width rather than opacity (an opacity-0 flex child still reserves its track, which once starved
  // the hint line down to 100px). The keyboard-hint chip was removed as clutter, so the assertion has no
  // subject left. The lesson survives in PLAN.md §3.0 for whoever adds the next flex child here.

  it("collapses everything to a plain opacity fade under prefers-reduced-motion, no stagger", () => {
    const blocks = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(2); // one for the hint cascade, one for the width tween

    const hintBlock = blocks.find((b) => b.includes(".canvas-nl-hint-word")) ?? "";
    expect(hintBlock).not.toBe("");
    expect(hintBlock).toMatch(/transition-delay:\s*0s\s*!important/);
    expect(hintBlock).toMatch(/transform:\s*none\s*!important/);

    // A width tween is a moving box — precisely what this query asks us not to do.
    const widthBlock = blocks.find((b) => b.includes(".canvas-nl-bar[data-docked]")) ?? "";
    expect(widthBlock).not.toBe("");
    expect(widthBlock).toMatch(/transition: none/);
  });

  it("clears the bottom-right corner controls from a MEASURED width, not a hardcoded number", () => {
    // This started life as a flat 172px derived from .canvas-zoom-control alone and it overlapped the
    // real widget, because the real widget is .canvas-corner-bar — wider, and variable (its memory
    // button is conditional on an open project, its zoom label grows with the percentage). The strip
    // sat on the zoom buttons and they could not be clicked. The reservation now comes from
    // --canvas-corner-bar-w, published by CanvasCornerControlBar via a ResizeObserver.
    const veilBar = rule('.canvas-nl-bar[data-docked][data-rest="veil"] {');
    expect(veilBar).toMatch(/--nl-strip-clear:[^;]*var\(--canvas-corner-bar-w/);
    // The fallback must be generous: if the observer never runs, overlapping the controls is a worse
    // failure than a slightly short strip.
    const fallback = /var\(--canvas-corner-bar-w,\s*(\d+)px\)/.exec(veilBar);
    expect(fallback).not.toBeNull();
    expect(Number(fallback![1])).toBeGreaterThanOrEqual(200);

    const veilRow = rule('.canvas-nl-bar[data-docked][data-rest="veil"] .canvas-nl-input-row {');
    expect(veilRow).toMatch(/margin-right:\s*var\(--nl-strip-clear\)/);
    // …and a hardcoded pixel reservation must never come back.
    expect(veilRow).not.toMatch(/margin-right:\s*\d+px/);

    // The gathered state must give that clearance back, or the pill could never reach its full
    // 620px width. Keyed on :focus-within alone now — the original rule also fired on :hover, which
    // is what made the strip oscillate (see the veil resting-state suite below).
    const gathered = rule('.canvas-nl-bar[data-docked][data-rest="veil"] .canvas-nl-input-row:focus-within {');
    expect(gathered).toMatch(/margin-right:\s*0\s*;/);
  });

  it("escapes the bar's own containing block for the veil gradient instead of the shell-level fix", () => {
    // .canvas-nl-bar is `position: absolute; left: 50%; transform: translateX(-50%)` — that transform
    // makes the bar its OWN containing block, so a `left: 0; right: 0` child (the mockup's approach)
    // would only span the bar's narrow box, not the window. `width: 100vw` sidesteps that: it isn't
    // relative to the containing block at all.
    const veil = rule(".canvas-nl-veil {");
    expect(veil).toMatch(/width:\s*100vw\s*;/);
    expect(veil).toMatch(/left:\s*50%\s*;/);
    expect(veil).toMatch(/transform:\s*translateX\(-50%\)\s*;/);
    expect(veil).toMatch(/pointer-events:\s*none\s*;/);
    // Invisible at rest for every design except Veil.
    expect(veil).toMatch(/opacity:\s*0\s*;/);
    expect(css).toMatch(/\.canvas-nl-bar\[data-rest="veil"\]\s*\.canvas-nl-veil\s*\{\s*opacity:\s*1/);
  });
});

/**
 * Veil-at-rest regression guards. All four of these were real, measured defects that produced the
 * reported "glitch when clicking the far ends of the bar" — verified in a real browser against this
 * stylesheet, not reasoned about. See plans/nl-command-bar-revamp/PLAN.md §8.
 */
describe("canvas-nl-bar.css — veil resting state (glitch fixes)", () => {
  const veilRow = '.canvas-nl-bar[data-docked][data-rest="veil"] .canvas-nl-input-row {';

  it("inverts the veil on light themes, since the veil IS the strip's contrast", () => {
    // The resting strip carries no fill and no border — the veil gradient is the ONLY thing giving
    // its text a ground. The base gradient is a near-black scrim, authored when every canvas theme
    // was dark and "knock the wallpaper back" and "go darker" were the same instruction.
    //
    // On a light theme they are opposites. --canvas-text is dark ink, and over rgba(3,4,8,0.74) it
    // measured 1.29:1 against the wallpaper behind: with Command bar set to Bottom strip the bar
    // did not look faint, it looked absent. The light branch takes it to 12.11:1.
    //
    // Asserted structurally rather than by colour so a future palette tweak does not fail here,
    // but DELETING the branch does.
    const light = rule('.codecanvas-shell[data-canvas-mode="light"] .canvas-nl-veil');
    expect(light).toMatch(/linear-gradient\(\s*to top/);
    expect(light).toMatch(/--node-floor-solid/);
    // The scrim must come from the theme's opaque page, never a literal — a hex here is the bug.
    expect(light).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("gives the gathered pill a ground that follows the theme, not a literal", () => {
    // Was `background-color: #121118`. The --canvas-surface-r layer over it hides that at 88% on
    // most themes, so the literal never blacked the pill out — it just cast 12% of near-black over
    // warm paper on the light one. --node-floor-solid is opaque by contract (terminal-floor.ts
    // emits `rgb(r, g, b)`; note-paper-contrast.test.ts pins that shape), so the opacity floor the
    // literal existed for is unchanged.
    // The gathered pill now wears the bar's shared glass (.canvas-nl-input-row::before in
    // agent-node-persona-nl.css), whose tint is still --node-floor-solid — so it follows the theme.
    const nl = readFileSync(resolve(process.cwd(), "src/styles/canvas/agent-node-persona-nl.css"), "utf8");
    const glass = nl.slice(nl.indexOf(".canvas-nl-input-row::before {"), nl.indexOf("}", nl.indexOf(".canvas-nl-input-row::before {")));
    expect(glass).toMatch(/background-color:\s*var\(--cc-glass-tint\)/);
    const theme = readFileSync(resolve(process.cwd(), "src/styles/canvas/theme.css"), "utf8");
    expect(theme).toMatch(/--cc-glass-tint:\s*color-mix\(in oklab, var\(--node-floor-solid,\s*#[0-9a-fA-F]{6}\)/);
    // The strip only fades that layer; it must not paint a second ground of its own.
    expect(rule('.canvas-nl-bar[data-docked][data-rest="veil"] .canvas-nl-input-row::before')).not.toMatch(/background/);
  });

  it("gathers on focus only — never on hover", () => {
    // Hover cannot drive a layout change on a window-wide element: gathering moves the row out from
    // under the pointer (left edge travels 545px), which cancels :hover, which restores the wide
    // row, which puts the pointer back inside — a ~300ms flicker loop at both ends of the strip.
    expect(css).toContain('.canvas-nl-bar[data-docked][data-rest="veil"] .canvas-nl-input-row:focus-within');
    expect(css).not.toMatch(/\[data-rest="veil"\][^{]*\.canvas-nl-input-row:hover/);
    // the veil gradient's own fade must follow the same trigger, or it flickers in lockstep
    expect(css).not.toMatch(/:has\(\.canvas-nl-input-row:hover\)/);
  });

  it("keeps the row centred at rest so no non-animatable property changes on engage", () => {
    // align-self is discrete: flipping stretch→center snapped the left edge across the window in one
    // frame while the width tweened behind it. Rest and gathered may differ only in width/margin.
    expect(rule(veilRow)).toMatch(/align-self:\s*center/);
  });

  it("fades the surface through a ::before opacity layer, not background-image", () => {
    // background-image is a discrete property — animating none→gradients popped the theme layers in
    // instantly while border/shadow eased. opacity interpolates.
    const row = rule(veilRow);
    expect(row).toMatch(/background-image:\s*none/);
    expect(row).not.toMatch(/transition:[^;]*background-image/);
    const before = rule('.canvas-nl-bar[data-docked][data-rest="veil"] .canvas-nl-input-row::before {');
    expect(before).toMatch(/opacity:\s*0/);
    expect(before).toMatch(/transition:\s*opacity/);
    expect(css).toMatch(/\.canvas-nl-input-row:focus-within::before\s*\{\s*opacity:\s*1/);
  });

  it("stops the invisible resting strip from swallowing canvas clicks", () => {
    // ~1500×36px of deliberately invisible chrome sits over the board, and .canvas-nl-bar halts
    // pointerdown propagation — every click in that dead space died before reaching the node under
    // it. The strip is pointer-transparent at rest, with events handed back only to what is visible.
    const guard = '.canvas-nl-bar[data-docked][data-rest="veil"]:not(:has(.canvas-nl-input-row:focus-within))';
    expect(rule(`${guard} {`)).toMatch(/pointer-events:\s*none/);
    for (const visible of [".canvas-nl-input", ".canvas-nl-icon", ".canvas-nl-docked"]) {
      expect(css, `${visible} must get pointer events back`).toContain(`${guard} ${visible}`);
    }
    // The textarea spans the whole 1fr column, so re-enabling it would hand the dead space straight
    // back — its hit area is capped to roughly where the hint text actually is.
    expect(css).toMatch(/:not\(:has\(\.canvas-nl-input-row:focus-within\)\) \.canvas-nl-input \{\s*max-width:/);
  });
});

/**
 * Focus choreography guards. The growth had no transition at all — measured in a real browser as
 * rest 560 → 620 on frame 0, while its contents eased in behind it. See PLAN.md §9.
 */
describe("canvas-nl-bar.css — focus choreography", () => {
  it("animates the bar's width instead of snapping it", () => {
    // Without this the container jumps its full 60px in one frame while its contents glide — the
    // exact mismatch that read as "not smooth".
    const barRule = rule(".canvas-nl-bar[data-docked] {");
    expect(barRule).toMatch(/transition:\s*width\s+\d+ms/);
  });

  it("uses a spread-out curve for geometry, not the canvas expo-out", () => {
    // --canvas-ease-out is cubic-bezier(0.16, 1, 0.3, 1): measured, it covered 83% of this tween in
    // the first 60ms of 260ms, so the box still arrived like a snap with a slow tail. Expo-out is for
    // colour and opacity, where there is no travel to perceive.
    const barRule = rule(".canvas-nl-bar[data-docked] {");
    expect(barRule).toContain("--canvas-nl-ease-geometry");
    expect(barRule).not.toMatch(/transition:\s*width[^;]*--canvas-ease-out/);
    // the veil gather's geometry legs must use the same curve
    const veilRow = rule('.canvas-nl-bar[data-docked][data-rest="veil"] .canvas-nl-input-row {');
    expect(veilRow).toMatch(/width\s+\d+ms\s+var\(--canvas-nl-ease-geometry/);
  });

  it("gives focus a visible accent signal, not a 6% ink nudge", () => {
    const focused = rule('.canvas-nl-bar[data-docked][data-rest="slab"] .canvas-nl-input-row:focus-within {');
    expect(focused).toMatch(/border-color:[^;]*--canvas-accent/);
    expect(focused).toMatch(/box-shadow:[\s\S]*0 0 0 3px[^;]*--canvas-accent/);
  });

  it("dims the prompt on focus without bleeding a ghost behind typed text", () => {
    // The guard matters: `.canvas-nl-input-row:focus-within .canvas-nl-hint` (0,3,0) outranks
    // `.canvas-nl-hint[data-empty="false"] { opacity: 0 }` (0,2,0), so an unguarded rule would leave a
    // 0.72-opacity line sitting behind whatever the user typed.
    expect(css).toContain('.canvas-nl-input-row:focus-within .canvas-nl-hint[data-empty="true"]');
    expect(css).not.toMatch(/\.canvas-nl-input-row:focus-within \.canvas-nl-hint \{/);
  });

  it("drops the width tween under prefers-reduced-motion", () => {
    // A width tween is a moving box, which is what reduced-motion asks us not to do. The colour/shadow
    // fade may stay — it carries no motion.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.canvas-nl-bar\[data-docked\] \{ transition: none/);
  });
});

describe("canvas-nl-bar.css — bottom strip room for typing", () => {
  it("gives the field a longer hit area in strip mode than the first, cramped cap", () => {
    // The cap is a deliberate trade-off and the number IS the argument: inside it, a click focuses the
    // field; past it, the click reaches the canvas node underneath (that is the pointer-events fix in
    // the suite above). 26rem was too tight to read a long command in a window-wide strip.
    const capped = /:not\(:has\(\.canvas-nl-input-row:focus-within\)\) \.canvas-nl-input \{\s*max-width:\s*([\d.]+)rem/.exec(css);
    expect(capped).not.toBeNull();
    expect(Number(capped![1])).toBeGreaterThanOrEqual(40);
  });

  it("no longer ships the keyboard-hint chip", () => {
    // Removed as clutter: it ate width the prompt wanted, and Settings → Hotkeys is where someone
    // actually goes looking for a shortcut. Guard against it creeping back into the CSS.
    expect(css).not.toMatch(/\.canvas-nl-keys\s*\{/);
    expect(css).not.toMatch(/\.canvas-nl-kbd\s*\{/);
  });
});
