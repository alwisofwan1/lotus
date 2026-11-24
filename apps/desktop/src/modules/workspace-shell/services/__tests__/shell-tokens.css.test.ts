import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The shell's token contract, enforced.
 *
 * A mistyped custom property is the quietest bug in CSS: `var(--ws-tint-stong)` resolves to
 * nothing, the rule is dropped, and the surface renders as whatever was underneath — which
 * usually still looks plausible. These checks make that a failing test instead of a design
 * review three weeks later.
 */

const CSS_PATH = path.resolve(__dirname, "../../../../styles/workspace-shell.css");
const css = readFileSync(CSS_PATH, "utf8");

/** The `.ws-shell { … }` block, where every shell token has to be declared. */
function shellTokenBlock(): string {
  const start = css.indexOf(".ws-shell {");
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index);
    }
  }
  throw new Error("unterminated .ws-shell block");
}

const declared = new Set([...shellTokenBlock().matchAll(/(--ws-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const referenced = [...css.matchAll(/var\((--ws-[a-z0-9-]+)/g)].map((m) => m[1]);

describe("workspace shell tokens", () => {
  it("declares every --ws-* token it uses", () => {
    // Set per element rather than globally: `--ws-kind` by data-kind, `--ws-activity-tone` by
    // data-tone on the activity badge, `--ws-tone`, `--ws-mode-index` and `--ws-runner-logo` by
    // inline style (the mode thumb's position is state, and a pane's runner logo is a file path —
    // neither is a value the token block could hold), and `--ws-rail-w` / `--ws-rail-shift` on a
    // mode's body while its rail slides (the rail's width is layout state), and `--ws-row-index` per rail row for the fold's stagger, and the Frame colour set (`--ws-frame-h`, `--ws-frame-hue`, `--ws-card-bg`, `--ws-card-line`, `--ws-card-hover`, `--ws-card-active`) by a Frame row's data-color.
    const contextual = new Set([
      "--ws-kind",
      "--ws-tone",
      "--ws-mode-index",
      "--ws-activity-tone",
      "--ws-runner-logo",
      "--ws-rail-w",
      "--ws-rail-shift",
      "--ws-row-index",
      "--ws-frame-hue",
      "--ws-frame-h",
      "--ws-card-bg",
      "--ws-card-line",
      "--ws-card-hover",
      "--ws-card-active",
    ]);
    const missing = [...new Set(referenced)].filter((token) => !declared.has(token) && !contextual.has(token));
    expect(missing).toEqual([]);
  });

  it("keeps every declared token in use", () => {
    const used = new Set(referenced);
    const unused = [...declared].filter((token) => !used.has(token));
    expect(unused).toEqual([]);
  });

  it("stays flat: no gradients anywhere in the shell", () => {
    // Depth here is a value step and a hairline. A gradient that creeps back in is how a calm
    // surface starts drifting back towards decoration.
    // One exception, by name: the working halo is a comet stroke, which needs a conic sweep and a
    // ring mask (mockups/rail-working-indicator-v2.html). It is a shape that moves, not a surface.
    const withoutHalo = css.replace(/\.ws-rail-item-mark::after \{[^}]*\}/, "");
    expect(withoutHalo).not.toMatch(/linear-gradient|radial-gradient|conic-gradient/);
  });

  it("spends no blur at all", () => {
    // `backdrop-filter` costs real frames in a WKWebView and buys nothing over a flat surface.
    expect(css).not.toContain("backdrop-filter");
  });

  it("covers motion with a reduced fallback", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("keeps raw colour literals out of the rules, so themes stay in control", () => {
    const body = css.slice(css.indexOf("/* ── Chrome"));
    const literals = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(literals).toEqual([]);
  });
});

/** One rule block, by selector, so a check can read what it actually declares. */
function readRule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

describe("the hidden mode surface", () => {
  /**
   * A regression with a face: with `visibility: hidden`, Code's two live terminals drew straight
   * through the Chat conversation in the native window (2026-09-20). The pooled terminal slot
   * writes `style.visibility = "visible"` on its own element when it attaches, and a descendant
   * saying that reappears through a hidden ancestor. Opacity composites the whole subtree and
   * cannot be overridden from inside it.
   */
  it("hides with opacity rather than visibility, which a child can override", () => {
    const rule = readRule(".ws-surface");
    expect(rule).toContain("opacity: 0");
    expect(rule).toContain("pointer-events: none");
    expect(rule).not.toContain("visibility: hidden");
  });

  /**
   * And not `display: none` either: that is what tore the layout down and made returning to Code
   * re-attach every terminal — p50 192ms with two of them, against 34ms once they stayed.
   */
  /**
   * The same face again (2026-10-25): the column under the Tasks overlay was hidden with
   * `visibility`, and the overlay is transparent, so the terminals drew through the tracker's nav.
   */
  it("hides the column under an overlay with opacity too", () => {
    const rule = readRule(".ws-column[inert]");
    expect(rule).toContain("opacity: 0");
    expect(rule).not.toContain("visibility: hidden");
  });

  it("keeps the hidden mode laid out, so nothing has to be measured again", () => {
    const rule = readRule(".ws-surface");
    expect(rule).not.toContain("display: none");
    expect(rule).toContain("position: absolute");
  });
});

describe("the mode switcher's thumb", () => {
  /**
   * The thumb moves by `transform`, which the compositor can do without a layout pass, and its
   * width is derived from the same three-tab arithmetic the tabs use. Animating `left` instead
   * would lay the title bar out again on every frame of a switch.
   */
  it("travels with a transform, not with a layout property", () => {
    const rule = readRule(".ws-mode-thumb");
    expect(rule).toMatch(/transform:\s*translateX\(calc\(var\(--ws-mode-index/);
    expect(rule).toContain("var(--ws-ease-spring)");
  });

  /** Equal tabs are what makes `index × 100%` land on the right one. */
  it("keeps every tab the same width", () => {
    const rule = readRule(".ws-mode");
    expect(rule).toContain("flex: 1 1 0");
    expect(rule).toContain("min-width");
  });
});

describe("shell layers (mockup 10, T2)", () => {
  /**
   * The rail sits flush on its own theme step (`--ds-rail`), with at most one edge between it and
   * the work (`--ds-rail-edge`: a hairline in Light, none in Dark): the sidebar is the ground, not
   * a card on it. A border all round plus a fill would draw the rail as one more pane.
   */
  it("grounds the shell on the canvas step", () => {
    expect(readRule(".ws-shell .ws-rail")).toContain("background: var(--ds-rail)");
    expect(css).toMatch(/\.ws-shell \{[^}]*background: var\(--ds-canvas\)/);
  });

  it("separates the rail from the content with one hairline, not a card border", () => {
    const rail = readRule(".ws-shell .ws-rail");
    expect(rail).toContain("border: 0");
    expect(rail).toContain("border-right: 1px solid var(--ds-rail-edge)");
    expect(rail).toContain("border-radius: var(--ws-r-card)");
  });

  /** Active is a fill under a fading dither, in primary text. No hairline, no accent. */
  it("marks the active nav row with the active fill and the dither, not the accent", () => {
    const rule = readRule('.ws-rail-nav-item[data-active="true"]');
    expect(rule).toContain("background: var(--ws-surface-quiet)");
    expect(rule).toContain("color: var(--fg)");
    expect(css).toContain('.ws-rail-nav-item[data-active="true"]::after');
  });

  /** A pane row is active the way a Chat thread is: a plain fill, no dither (mockups/code-rail-refine.html). */
  it("marks the active pane row with Chat's plain fill, not the dither", () => {
    const rule = readRule('.ws-rail-item[data-active="true"]');
    expect(rule).toContain("background: color-mix(in oklab, var(--fg) 7.5%, transparent)");
    expect(rule).toContain("color: var(--fg)");
    expect(css).not.toContain('.ws-rail-item[data-active="true"]::after');
  });

  it("lets the native glass through on macOS with a tinted ground, never a CSS blur", () => {
    expect(readRule('[data-window-glass="true"] .ws-shell')).toContain("background: var(--ds-glass-ground)");
    expect(css).not.toContain('[data-window-glass="true"] .ws-shell .ws-rail');
  });

  it("marks the focused pane with the dithered reticle, locked on inside the half-seam", () => {
    const rest = readRule(".ws-pane::before");
    expect(rest).toContain("mask:");
    expect(rest).toContain("opacity: 0");
    const focused = readRule('.ws-pane[data-focused="true"]::before');
    expect(focused).toContain("inset: -4px");
    expect(focused).toContain("var(--ws-ease-spring)");
  });

  it("leaves folder headings unfilled, open or showing: only the row beneath carries the mark", () => {
    // An open folder has no rule of its own any more: open is the chevron's job.
    expect(css).not.toMatch(/\.ws-rail-group\[data-open="true"\]\s*\{[^}]*background/);
    expect(readRule('.ws-rail-group[data-active="true"]')).not.toContain("background");
    expect(css).not.toContain('.ws-rail-group[data-active="true"]::after');
  });

  it("draws the active dither under the label, in the theme's ink, through a pixel mask", () => {
    const rule = readRule('.ws-rail-nav-item[data-active="true"]::after,\n.ws-sheet-cursor::after');
    expect(rule).toContain("background: var(--ws-dither-ink)");
    expect(rule).toContain("z-index: -1");
    expect(rule).toContain("mask: var(--ws-dither-fill)");
  });

  it("labels rail groups quietly, in Chat's sentence case", () => {
    const rule = readRule(".ws-rail-section");
    expect(rule).toContain("color: var(--ds-text-quiet)");
    expect(rule).not.toContain("text-transform: uppercase");
  });
});
