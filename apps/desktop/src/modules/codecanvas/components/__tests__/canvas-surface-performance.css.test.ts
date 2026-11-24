import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

/** Strip /* … *​/ comments so token bans assert on real declarations, not prose (a comment that
 *  merely NAMES a forbidden token — "we avoid --canvas-bg here" — must not trip the policy). */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Read + join a group of canvas CSS files (oversized files are split per the ≤600-line policy). */
function readCanvasCss(...names: string[]): string {
  return names
    .map((name) => readFileSync(resolve(process.cwd(), `src/styles/canvas/${name}`), "utf8"))
    .join("\n");
}

describe("canvas surface CSS performance policy", () => {
  const themeCss = readCanvasCss("theme.css");
  const controlsCss = readCanvasCss("controls.css");
  const panelsCss = readCanvasCss("panels.css", "panels-picker.css", "panels-collab.css");
  const edgesCss = readCanvasCss("edges.css");
  const agentCss = readCanvasCss("agent-node.css", "agent-node-graph.css", "agent-node-plan-composer.css", "agent-node-persona-nl.css");
  const layoutCss = readCanvasCss("layout.css", "layout-panels.css");
  const canvasesModalCss = readCanvasCss("canvases-modal.css");
  const sheetCss = readCanvasCss("canvas-command-sheet.css");
  const settingsModalCss = readCanvasCss("settings-modal.css", "settings-modal-tabs.css", "settings-modal-style.css", "settings-modal-templates.css");

  it("keeps persistent controls and the command sheet off backdrop blur", () => {
    expect(cssRule(controlsCss, ".canvas-zoom-control")).not.toMatch(/backdrop-filter/);
    // The ⌘K surface used to be a centred modal (.canvas-command-palette-*) in controls.css; it is
    // now a sheet inside the NL command bar, and it inherits the same policy — a persistent control
    // over a canvas that may be playing a video wallpaper.
    // Comments stripped: the file NAMES the banned property in a cautionary note, which the
    // policy must not read as a declaration (the same allowance every other check here makes).
    expect(stripCssComments(sheetCss)).not.toMatch(/backdrop-filter/);
  });

  it("makes the command sheet a bulletproof SOLID, theme-aware surface (no wallpaper bleed)", () => {
    const panel = cssRule(sheetCss, ".canvas-sheet");
    // Opacity floor: an OPAQUE colour reaches `background-color`, so a translucent theme token can
    // never make the panel see-through — this is what fixes the transparent-palette bug.
    //
    // The sheet reaches it through --canvas-sheet-ground rather than writing a literal inline,
    // because the PINNED send row has to paint the same ground to hide the rows scrolling under it,
    // and two literals are one edit away from disagreeing.
    //
    // The ground is --node-floor-solid, not a hex, and the floor is intact: that token is
    // resolveTerminalFloor's output, formatted `rgb(r, g, b)` with no alpha channel available to
    // it, and note-paper-contrast.test.ts pins that shape for every built-in. The hex fallback
    // covers a shell the resolver has not reached. Asserting the exact source (rather than "some
    // var") is what keeps this a floor: a future edit to a translucent token fails here.
    expect(panel).toMatch(
      /--canvas-sheet-ground:\s*var\(--node-floor-solid,\s*#[0-9a-fA-F]{6}\s*\)\s*;/,
    );
    expect(panel).toMatch(/background-color:\s*var\(--canvas-sheet-ground\)\s*;/);
    // Theme-aware: the panel recolours with the active style via --canvas-surface-r (always a valid
    // rgba) plus an accent wash. Both ride in the droppable background-image.
    expect(panel).toMatch(/background-image:[\s\S]*?--canvas-surface-r/);
    expect(panel).toMatch(/background-image:[\s\S]*?--canvas-accent/);
    // Never source the fill from a token that themes bleed to near-0 alpha / a non-colour: those are
    // exactly what made it transparent. Declarations only — cautionary comment mentions are fine.
    expect(stripCssComments(panel)).not.toMatch(/--canvas-bg/);
    expect(stripCssComments(panel)).not.toMatch(/background-color:[^;]*--canvas-surface\b/);
    // Still OFF backdrop blur (persistent-control perf policy — also asserted above).
    expect(panel).not.toMatch(/backdrop-filter/);
  });

  it("uses bounded panel blur instead of the old high-cost glass", () => {
    // The bounded blur is now wrapped in the --ct-* indirection (Phase 0b), so match
    // the value wherever it appears (literal or as the var() fallback).
    expect(themeCss).toMatch(/--panel-glass-filter:[^;]*blur\(18px\) saturate\(1\.24\) brightness\(1\.02\)/);
    expect(cssRule(panelsCss, ".canvas-worktree-panel")).toMatch(/backdrop-filter:\s*blur\(18px\) saturate\(1\.24\) brightness\(1\.02\);/);
    expect(panelsCss).not.toMatch(/blur\(32px\)/);
  });

  it("provides reduced-transparency fallbacks for panels and transient wire chrome", () => {
    expect(panelsCss).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\.canvas-panel,[\s\S]*?backdrop-filter:\s*none;/);
    expect(edgesCss).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\.canvas-connection-line-label,[\s\S]*?backdrop-filter:\s*none;/);
  });

  it("keeps persistent layout chrome cheap and bounds agent overlay blur", () => {
    expect(cssRule(layoutCss, ".canvas-topnav")).toMatch(/backdrop-filter:\s*none;/);
    expect(agentCss).not.toMatch(/blur\((?:20|22)px\)/);
    expect(agentCss).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\.canvas-add-agent-menu,[\s\S]*?\.canvas-composer,[\s\S]*?backdrop-filter:\s*none;/);
  });

  it("bounds modal blur and provides reduced-transparency modal fallbacks", () => {
    expect(cssRule(canvasesModalCss, ".canvases-modal")).toMatch(/backdrop-filter:\s*blur\(12px\) saturate\(1\.06\);/);
    expect(cssRule(settingsModalCss, ".save-template-modal")).toMatch(/backdrop-filter:\s*blur\(14px\) saturate\(1\.18\);/);
    expect(canvasesModalCss).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\.canvases-modal[\s\S]*?backdrop-filter:\s*none;/);
    expect(settingsModalCss).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\.canvas-settings-backdrop,[\s\S]*?\.save-template-modal[\s\S]*?backdrop-filter:\s*none;/);
  });

  it("makes the settings surface a bulletproof SOLID Graphite panel from the app palette", () => {
    // Two `.canvas-settings-surface {}` rules exist (scoped tokens + layout/background); grab the
    // layout block (the one carrying the box-shadow) to assert on the surface's actual fill.
    const blocks = settingsModalCss.match(/\.canvas-settings-surface\s*\{[\s\S]*?\n\}/g) ?? [];
    const layout = blocks.find((b) => /box-shadow/.test(b)) ?? "";
    expect(layout).not.toBe("");
    // Opacity is guaranteed by a plain opaque hex on its OWN background-color property.
    expect(layout).toMatch(/background-color:\s*#[0-9a-fA-F]{6}\s*;/);
    // Graphite (2026-11-07): Settings is app chrome — the app palette, never the canvas theme.
    const decls = stripCssComments(layout);
    expect(decls).toMatch(/background-image:[\s\S]*?--ds-bg/);
    expect(decls).not.toMatch(/--canvas-/);
    expect(decls).not.toMatch(/--cc-accent-src/);
    expect(layout).not.toMatch(/backdrop-filter/);
    expect(settingsModalCss).toMatch(/--cc-accent-src:\s*var\(--ds-accent/);
    expect(settingsModalCss).toMatch(/--cc-ink-src:\s*var\(--ds-text/);
  });

  it("gives the settings backdrop a hardened, bounded soft-focus blur", () => {
    const backdrop = cssRule(settingsModalCss, ".canvas-settings-backdrop");
    // A gentle blur softens the busy canvas behind the modal…
    expect(backdrop).toMatch(/backdrop-filter:\s*blur\((?:1[0-8]|[1-9])px\)/);
    // …with a plain rgba dim (NOT color-mix over --canvas-bg, which can invalidate the declaration).
    // Declarations only — the cautionary mention in the comment is allowed.
    expect(stripCssComments(backdrop)).not.toMatch(/--canvas-bg/);
  });

  it("draws the NL command bar and Top Bar as desaturated glass on ::before — no wallpaper hue bleed (PLAN.md §F1)", () => {
    // F1 made the bar solid because a translucent pill was tinted BY the photo (half near-black, half
    // green). The glass that replaced it fixes that at the source: the backdrop is desaturated before
    // the tint, so the wallpaper lends light, never hue.
    const row = cssRule(agentCss, ".canvas-nl-input-row");
    // Never on the row itself: a backdrop root there starves the blur of the menus that open inside it.
    expect(stripCssComments(row)).not.toMatch(/backdrop-filter/);
    // Both persistent bars draw the same --cc-glass-* recipe on a ::before.
    expect(cssRule(agentCss, ".canvas-nl-input-row::before")).toMatch(/backdrop-filter:\s*var\(--cc-glass-filter\)/);
    expect(cssRule(layoutCss, ".canvas-topnav::before")).toMatch(/backdrop-filter:\s*var\(--cc-glass-filter\)/);
    for (const [, value] of themeCss.matchAll(/--cc-glass-filter:\s*([^;]+);/g)) {
      const saturate = /saturate\(([\d.]+)\)/.exec(value);
      expect(saturate, value).not.toBeNull();
      expect(Number(saturate![1])).toBeLessThanOrEqual(0.5);
    }
    // Reduced transparency falls back to the old solid floor.
    expect(agentCss).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*\.canvas-nl-input-row::before \{[\s\S]*?backdrop-filter:\s*none;[\s\S]*?background-color:\s*#[0-9a-fA-F]{6};/);
  });

  it("keeps route-level blur out of the old 22px+ range", () => {
    const routeCss = [
      themeCss,
      controlsCss,
      panelsCss,
      edgesCss,
      agentCss,
      layoutCss,
      canvasesModalCss,
      settingsModalCss,
    ].join("\n");
    expect(routeCss).not.toMatch(/blur\((?:22|24|26|28|30|32|36)px\)/);
  });
});
