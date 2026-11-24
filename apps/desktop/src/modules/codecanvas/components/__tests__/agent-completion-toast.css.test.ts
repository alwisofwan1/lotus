import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Extract a top-level rule body by selector (same helper shape as the other canvas CSS guards). */
function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match, `missing rule: ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

/** Same, but joins EVERY top-level block for a selector — the toast splits its card rules into a
 *  "material" block and a "geometry" block, and either may hold the declaration under test. */
function cssRules(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "gm"))].map((m) => m[0]);
  expect(all.length, `missing rule: ${selector}`).toBeGreaterThan(0);
  return all.join("\n");
}

/** Strip comments so token bans assert on real declarations, not the prose explaining them. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function readCanvasCss(name: string): string {
  return readFileSync(resolve(process.cwd(), `src/styles/canvas/${name}`), "utf8");
}

/**
 * The completion toast's material contract (revamp Jul 2026). The card used to be a hardcoded warm
 * graphite slate with pinned slate ink, which meant it ignored the active Artisan theme entirely —
 * these assertions are what stop that from creeping back.
 */
describe("agent completion toast CSS material", () => {
  const toastCss = readCanvasCss("agent-completion-toast.css");
  const bare = stripCssComments(toastCss);
  const themeCss = stripCssComments(readCanvasCss("theme.css"));

  it("derives every toast token from the active theme's --canvas-* palette", () => {
    // Surface, ink, border, and both status hues must trace back to theme tokens, so the card
    // re-skins (and inverts on a light theme) instead of carrying its own palette.
    for (const decl of [
      "--cc-toast-base:",
      "--cc-toast-ink:",
      "--cc-toast-ink-muted:",
      "--cc-toast-border:",
      "--cc-toast-ok:",
      "--cc-toast-accent:",
    ]) {
      const line = themeCss.match(new RegExp(`${decl.replace(/[-]/g, "\\$&")}[^;]*;`))?.[0] ?? "";
      expect(line, `${decl} must be defined`).not.toBe("");
      expect(line, `${decl} must derive from --canvas-*`).toMatch(/var\(--canvas-|var\(--cc-toast-/);
    }
  });

  it("has no stray comment terminator swallowing a declaration", () => {
    // A malformed comment in the token block once ate --cc-toast-base whole: the card silently fell
    // back to its hardcoded hex and stopped following the theme, with every other token still fine.
    // Nothing else caught it, because a token ban that greps the raw text still "sees" the name.
    for (const [name, css] of [["theme.css", themeCss], ["agent-completion-toast.css", bare]] as const) {
      expect(css, `${name} has a */ outside a comment`).not.toMatch(/\*\//);
    }
  });

  it("keeps exactly one non-theme hue — the lamplight ember that makes the card read warm", () => {
    const warm = themeCss.match(/--cc-toast-warm:[^;]*;/)?.[0] ?? "";
    expect(warm).toMatch(/#[0-9a-f]{6}/i);
  });

  it("paints --canvas-bg as the bottom layer so the card is opaque without any blur", () => {
    const card = cssRules(bare, ".canvas-agent-toast");
    expect(card).toMatch(/background:[\s\S]*var\(--canvas-bg/);
    // The surface colour must stay wrapped in a gradient: only the LAST layer of the shorthand may
    // be a colour, so a bare colour mid-list silently invalidates the whole background.
    expect(card).toMatch(/linear-gradient\(var\(--cc-toast-surface[^)]*\), var\(--cc-toast-surface/);
    // Glass was dropped deliberately: it melted into the dark canvas. Blur must not return.
    expect(bare).not.toMatch(/backdrop-filter/);
  });

  it("no longer pins ink or surface to the old hardcoded slate palette", () => {
    // The exact hexes the pre-revamp card was locked to.
    for (const hex of ["#2a2924", "#262521", "#f5f4ef", "#a8a49c", "#cfcbc1", "#6da871", "#d97757", "#e48a66"]) {
      // Fallback values inside var() are allowed (they only apply when theme.css is absent), so the
      // ban targets bare declarations: `property: <hex>` with no var() wrapper on the line.
      const bareUse = new RegExp(`:\\s*${hex}\\s*(?:;|\\))`, "i");
      const lines = bare.split("\n").filter((l) => bareUse.test(l) && !l.includes("var("));
      expect(lines, `${hex} is still applied directly`).toEqual([]);
    }
  });

  it("drives the life bar off the toast's own duration with a compositor-only animation", () => {
    const life = cssRule(bare, ".canvas-agent-toast__life");
    expect(life).toMatch(/animation:\s*canvas-agent-toast-life var\(--toast-life/);
    expect(life).toMatch(/transform-origin:\s*left/);
    // Only transform animates — no width/left keyframes, which would trigger layout every frame.
    const keyframes = bare.match(/@keyframes canvas-agent-toast-life\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(keyframes).toMatch(/scaleX\(1\)/);
    expect(keyframes).toMatch(/scaleX\(0\)/);
    expect(keyframes).not.toMatch(/width|left|right/);
  });

  it("pauses the visible drain whenever the deck is open, matching the JS countdown pause", () => {
    expect(bare).toMatch(
      /\.canvas-agent-toast-list\[data-open="true"\] \.canvas-agent-toast__life[\s\S]*?animation-play-state:\s*paused/,
    );
  });

  it("signals scope through one variable the whole card inherits", () => {
    expect(cssRules(bare, ".canvas-agent-toast")).toMatch(/--cc-toast-signal:\s*var\(--cc-toast-ok/);
    expect(cssRule(bare, ".canvas-agent-toast--background")).toMatch(/--cc-toast-signal:\s*var\(--cc-toast-accent/);
    // Seal, life bar, and the seal's ambient pool all read the same signal instead of each
    // restating a per-scope colour.
    expect(cssRule(bare, ".canvas-agent-toast__seal-body")).toMatch(/var\(--cc-toast-signal\)/);
    expect(cssRule(bare, ".canvas-agent-toast__life")).toMatch(/var\(--cc-toast-signal\)/);
    expect(cssRule(bare, ".canvas-agent-toast__seal::after")).toMatch(/var\(--cc-toast-signal\)/);
  });

  it("keeps the hover lift inside the deck transform so it never fights the stack geometry", () => {
    expect(cssRules(bare, ".canvas-agent-toast")).toMatch(
      /transform:\s*translateY\(calc\(var\(--stack-y\) \+ var\(--lift\)\)\) scale\(var\(--stack-s\)\)/,
    );
  });

  it("keeps the deck rem geometry in sync with the service constants", () => {
    // TOAST_CARD_H_REM = 2.5 · gap 0.5 → open offset 3rem · peek 0.5625rem.
    expect(cssRules(bare, ".canvas-agent-toast")).toMatch(/height:\s*2\.5rem/);
    expect(bare).toMatch(/--stack-y: calc\(var\(--stack-i, 0\) \* -3rem\)/);
  });

  it("carries no coloured side stripe — a banned pattern, and the seal already says it", () => {
    // The card used to paint a 3px signal-coloured ::before down its left edge. Thick coloured side
    // borders are house-banned; scope now reads from the seal hue, the project ink, and the ↗.
    expect(bare).not.toMatch(/\.canvas-agent-toast::before/);
    for (const rule of [".canvas-agent-toast", ".canvas-agent-toast--background"]) {
      expect(cssRules(bare, rule)).not.toMatch(/border-(left|right):\s*(?!1px)/);
    }
  });

  it("keeps name and project as two stacked lines, each truncating on its own", () => {
    // The structure is settled (approved): compaction is bought with the box and the leading, never
    // by merging the pair into one row. A single-row variant was tried and rejected.
    expect(cssRule(bare, ".canvas-agent-toast__title")).toMatch(/display:\s*block/);
    expect(cssRule(bare, ".canvas-agent-toast__sub")).toMatch(/display:\s*block/);
    for (const part of [".canvas-agent-toast__title", ".canvas-agent-toast__sub"]) {
      expect(cssRule(bare, part)).toMatch(/text-overflow:\s*ellipsis/);
      expect(cssRule(bare, part)).toMatch(/white-space:\s*nowrap/);
    }
    // Tight leading is what buys the 40px box; anything looser overflows two lines out of it.
    expect(cssRule(bare, ".canvas-agent-toast__title")).toMatch(/line-height:\s*1\.15/);
    expect(cssRule(bare, ".canvas-agent-toast__sub")).toMatch(/line-height:\s*1\.2/);
  });

  it("keeps state transitions inside the product motion range (150-250ms)", () => {
    // Users see this card dozens of times a session; a 400ms entry made it feel like choreography.
    const durations = [...bare.matchAll(/(?:animation|transition)[^;]*?(\d{3})ms/g)].map((m) => Number(m[1]));
    expect(durations.length).toBeGreaterThan(0);
    for (const ms of durations) expect(ms).toBeLessThanOrEqual(260);
  });

  it("still honours reduced motion for the card slide", () => {
    expect(bare).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?canvas-agent-toast-out-fade/);
  });
});
