import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * A rule with its comments removed.
 *
 * The comments in this stylesheet quote the code they replaced — the note on `.canvas-fleet-detail`
 * spells out the dead `var(--canvas-sidebar-muted, …)` fallback it exists to explain. An assertion
 * that the rule no longer USES something has to read the declarations, or the explanation of why it
 * was removed is enough to fail it.
 */
function decls(rule: string): string {
  return rule.replace(/\/\*[\s\S]*?\*\//g, "");
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

/**
 * The Fleet rows' styles (`CanvasFleetPanel`, shown in the Canvas Dock). The rail that first carried
 * them is gone; the rows and their states are what these pin now.
 */
describe("fleet rows", () => {
  const css = readFileSync(
    resolve(process.cwd(), "src/styles/canvas/agent-node-graph.css"),
    "utf8",
  );

  it("keeps the header while the list scrolls", () => {
    expect(cssRule(css, ".canvas-fleet-header")).toMatch(/flex:\s*0 0 auto/);
    expect(cssRule(css, ".canvas-fleet-scroll")).toMatch(/overflow-y:\s*auto/);
  });

  it("gives a row a real click target, not a line of text", () => {
    // 56px, up from the sidebar's 26px. Three lines now — who it is, what it is for, what it is
    // doing — and this panel is also a `ViewportPortal` child, so it scales with the board: a row
    // that only just works at 100% is not a list at 60%.
    expect(cssRule(css, ".canvas-fleet-focus")).toMatch(/min-height:\s*3\.5rem/);
  });

  it("answers the keyboard", () => {
    // Every interactive element in this panel is reachable by tab, so all actions need a visible ring.
    expect(cssRule(css, ".canvas-fleet-focus:focus-visible")).toMatch(/box-shadow:/);
    expect(cssRule(css, ".canvas-fleet-rename-action:focus-visible")).toMatch(/box-shadow:/);
    expect(cssRule(css, ".canvas-fleet-close:focus-visible")).toMatch(/box-shadow:/);
  });

  it("gives terminal rename a compact inline editor", () => {
    expect(cssRule(css, ".canvas-fleet-rename")).toMatch(/min-height:\s*3\.5rem/);
    expect(cssRule(css, ".canvas-fleet-rename-input")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("shouts at neither line", () => {
    // The name used to be uppercased here, inherited from the sidebar where the column was chrome.
    // On a panel this wide it costs twice: capitals plus tracking spend the width the rail was
    // widened to have, and a name in capitals is read letter by letter instead of recognised by
    // its shape — which is the whole job of a list you scan. The DOM always held the true text, so
    // nothing about search, copy or the accessible name changes either way.
    expect(cssRule(css, ".canvas-fleet-name")).not.toMatch(/text-transform:\s*uppercase/);
    expect(cssRule(css, ".canvas-fleet-detail")).not.toMatch(/text-transform/);
  });

  it("lines the count up so it cannot jitter as agents come and go", () => {
    expect(cssRule(css, ".canvas-fleet-count")).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it("separates the bands with a rule instead of boxing each one", () => {
    // The grouping is real information; four nested containers would be decoration.
    expect(cssRule(css, ".canvas-fleet-section + .canvas-fleet-section")).toMatch(/border-top:/);
  });

  it("respects reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*canvas-fleet-focus/);
  });

  it("dims a state so it cannot be mistaken for an instruction", () => {
    // The two share one slot. Without a visual difference, "working" reads as something the operator
    // asked for — a label would explain it but cost more width than the column has.
    const rule = cssRule(css, ".canvas-fleet-state");

    expect(rule).toMatch(/font-style:\s*italic/);
    expect(rule).toMatch(/color-mix\([\s\S]*--canvas-sidebar-text/);
    // A ticking duration must not shuffle the line sideways under someone reading it.
    expect(rule).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  /**
   * A `var()` fallback only fires when the variable is UNDEFINED, and this one never is.
   *
   * `.canvas-fleet-detail` read `var(--canvas-sidebar-muted, rgba(247,242,234,0.55))` under a
   * comment explaining that the 0.55 raised it from the sidebar's 0.42 because "this surface
   * carries a photograph behind it". The raise never happened: `resolve-theme.ts` writes
   * `--ds-workbench-text-muted` on every theme change, so `--canvas-sidebar-muted` is always
   * defined and the fallback was dead code. The line rendered at 0.42 the whole time — the exact
   * value it was written to escape.
   *
   * `color-mix` cannot fail silently the same way, which is why these two lines now use it.
   */
  it("states the detail colour outright instead of hiding it in a fallback", () => {
    const rule = decls(cssRule(css, ".canvas-fleet-detail"));

    expect(rule).toMatch(/color:\s*color-mix\([\s\S]*--canvas-sidebar-text/);
    expect(rule).not.toMatch(/var\(--canvas-sidebar-muted/);
  });

  it("marks status on the edge the name starts from, at one pixel", () => {
    // A 5px dot at the far right meant crossing the whole panel to pair "which agent" with "doing
    // what", once per row. The edge says it in line with the name; the dot stays, because colour
    // alone is not an indicator.
    //
    // It was 2px and is now 1px. The bar was the loudest element in a panel drawn entirely from
    // hairlines and sub-10% light, and its square ends fought the row's 6px radius.
    expect(cssRule(css, ".canvas-fleet-edge")).toMatch(/width:\s*1px/);
    expect(css).toMatch(/\.canvas-fleet-row\[data-status="needs-you"\][\s\S]*?#a78bfa/);
  });

  /**
   * The bug this pins is a cascade collision, not a look.
   *
   * The stripe was written by ONE hero rule and by five status rules, and the hero rule shipped
   * last — so it won. A row you had selected that was also RUNNING silently stopped reporting that
   * it was running: two facts, one channel, and the less useful one took it. Selection now lives on
   * the row's surface and spends no hue, which is what frees the pixel to mean one thing.
   */
  it("never lets selection write the status edge", () => {
    expect(css).not.toMatch(/\[data-hero="true"\][^{]*\.canvas-fleet-edge[^{]*\{/);
    // Selection is depth plus ink, and neither is a colour that could be read as a state.
    const seat = decls(cssRule(css, '.canvas-fleet-row[data-hero="true"] .canvas-fleet-focus'));
    expect(seat).toMatch(/box-shadow:\s*[\s\S]*inset/);
    expect(seat).not.toMatch(/#fbbf24|#a78bfa|#34d399|#f87171/);
  });

  /**
   * Activity is a separate layer from status, and that separation is the feature.
   *
   * The edge is the state and never moves; the segment inside it travels. A hung agent therefore
   * holds a lit amber edge while being visibly motionless — which is information the panel could
   * not express before its timeout flipped the cell to `stalled`.
   */
  it("travels on a beat rather than looping, except when a human is wanted", () => {
    const traveller = decls(cssRule(css, ".canvas-fleet-edge > span"));
    // Cheap by construction: nothing here animates a layout property or paints a blur.
    expect(traveller).toMatch(/opacity:\s*0/);
    expect(traveller).not.toMatch(/\bfilter\s*:|\bwidth\s*:\s*\d+px/);
    // One pass, driven by the row's beat — `1` iteration, never `infinite`.
    const beat = decls(cssRule(css, '.canvas-fleet-row[data-beat="true"] .canvas-fleet-edge > span'));
    expect(beat).toMatch(/animation:[^;]*canvas-fleet-travel[^;]*\s1\b/);
    expect(beat).not.toMatch(/infinite/);
    // The single exception: an agent asking for a human is not waiting on output, so it cannot earn
    // a beat and loops instead.
    expect(decls(cssRule(css, '.canvas-fleet-row[data-status="needs-you"] .canvas-fleet-edge > span')))
      .toMatch(/infinite/);
    // Motion is optional; the state is not.
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*?\.canvas-fleet-edge > span[\s\S]*?animation:\s*none/);
  });

  /**
   * The active row.
   *
   * It read `var(--canvas-sidebar-active, rgba(255,255,255,0.085))` under a comment describing a
   * subtle 8.5% wash — and painted an opaque `#1a1a24` instead. `--canvas-sidebar-active` is
   * `var(--bg-elevated, #1a1a24)`, and `--bg-elevated` is defined nowhere: every appearance of it
   * in these stylesheets is a read with a fallback, and `resolve-theme.ts` never writes it. So the
   * selected row was a foreign opaque rectangle laid over a translucent panel. Its sibling
   * `--canvas-sidebar-hover` IS written at runtime, which is why hover looked right and selection
   * did not — the same dead-fallback class as the detail colour above.
   */
  it("lights the active row from its leading edge instead of slabbing it", () => {
    const bloom = decls(cssRule(css, ".canvas-fleet-row::before"));

    // Directional: the light enters at the leading edge, where the stripe is, and dies out across
    // the row. The exact origin is a tuning number — what must not drift is which side it enters
    // from, so the assertion reads the first source's x and requires it to be at that edge. A
    // negative value is legitimate and deliberate: pulling the core just outside the box keeps its
    // brightest part from being clipped flat against the border.
    const originX = Number(bloom.match(/radial-gradient\([\s\S]*?at\s+(-?[\d.]+)%/)?.[1]);
    expect(originX).toBeLessThanOrEqual(20);
    expect(bloom).toMatch(/transparent/);
    // Themed, and never a status colour — the reference this came from glows orange, and orange is
    // already `#fbbf24` here, the running state.
    expect(bloom).toMatch(/color-mix\([\s\S]*--canvas-accent/);
    expect(bloom).not.toMatch(/#fbbf24|#a78bfa|#34d399|#f87171/);
    // Additive. Alpha-compositing a pale colour over a dark panel can only make grey, which is
    // exactly what the first attempt looked like — a grey rectangle with a soft edge, not a glow.
    expect(bloom).toMatch(/mix-blend-mode:\s*plus-lighter/);
    // Faded through opacity: a multi-layer gradient cannot interpolate from "none", so painting it
    // straight on would snap it in on every promote.
    expect(bloom).toMatch(/opacity:\s*0/);
    // Held at 0.55, not 1: the bloom is one of three things saying "this row" now (seat, ink,
    // bloom), and at full strength it competed with the lit status edge beside it.
    expect(decls(cssRule(css, '.canvas-fleet-row[data-hero="true"]::before'))).toMatch(/opacity:\s*0\.55/);
  });

  /**
   * Theme fidelity.
   *
   * This panel re-skins with the active Artisan theme, and the way it broke was never a missing
   * rule — it was a literal. `rgba(0,0,0,.28)` for the seat punched the same neutral hole through a
   * warm theme and a cool one; a warm-white hero name stayed warm-white on a cyan palette. Neither
   * fails a render and neither fails a component test.
   *
   * The rule this pins: on this surface, everything that is not a run-state derives from a
   * `--canvas-*` token. Run-states are the deliberate exception — the ramp is theme-INDEPENDENT by
   * ADR-0023 §2b, so pinning them to a theme would make "running" mean a different colour per
   * theme. Drop shadows are the other: a shadow is an absence of light in every palette.
   */
  it("draws every neutral from the theme, and every run-state from the ramp", () => {
    // The WHOLE fleet block, not just the rows. The first version of this guard started at
    // `.canvas-fleet-row`, which left the panel shell, the header and the band titles — the exact
    // rules that carried the `rgba(255,255,255,0.11)` frame — outside anything that could catch a
    // literal coming back. They are clean today; that is the reason to fence them, not to skip them.
    const whole = decls(css);
    const first = whole.indexOf(".canvas-fleet");
    // End at the LAST fleet selector's rule rather than at some landmark that happens to sit near
    // the bottom. `.cth-dot` was that landmark for one revision and it is wrong twice over: it
    // occurs mid-block as `.canvas-fleet-focus .cth-dot`, and `indexOf(...) + 1 || length` silently
    // yields 0 when the pattern is missing, which would have sliced the region down to nothing and
    // passed forever.
    const last = whole.lastIndexOf(".canvas-fleet");
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    const untilNextArea = whole.slice(first, whole.indexOf("}", whole.indexOf("{", last)) + 1);

    // A literal INSIDE `var(--token, …)` is a fallback, not a hardcoded colour: the token is what
    // renders, and several of these tokens are written on every theme change. Strip the fallbacks
    // first, or this asserts the opposite of what it means — which it did on the first run, firing
    // on `var(--canvas-sidebar-hover, rgba(255,255,255,0.055))`, a correctly themed rule.
    // One level of nesting, because the fallbacks that matter here contain their own parentheses:
    // `var(--canvas-sidebar-hover, rgba(255,255,255,0.055))`. A `[^()]*` body stops at `rgba(` and
    // leaves the literal standing, which is exactly how the first fix still failed.
    const withoutFallbacks = untilNextArea.replace(/var\((?:[^()]|\([^()]*\))*\)/g, "var()");
    // `border`, not just `border-color`: the panel's own frame is written as the shorthand
    // `border: 1px solid rgba(255,255,255,0.11)`, and a guard that only named the longhand let the
    // single loudest literal on the surface walk straight past it. Verified by putting that exact
    // line back and watching this fail.
    const bareNeutral = /(?:background|color|border[a-z-]*)[^;]*rgba\(\s*(?:0,\s*0,\s*0|255,\s*255,\s*255)/;
    expect(withoutFallbacks).not.toMatch(bareNeutral);
    expect(withoutFallbacks).not.toMatch(/color:\s*#f{3,6}|#fffdf9|#fff4d6/i);

    // `box-shadow` needs a finer rule than "no literals", because the two kinds of layer in it are
    // not the same thing. A DROP shadow is an absence of light and stays black in every palette; an
    // INSET layer is a lit lip or a recess and has to follow the theme. Checked per layer, since
    // one declaration routinely carries both — which is exactly how the panel's
    // `inset 0 1px 0 rgba(255,255,255,0.1)` sat unnoticed beside two legitimate black drops.
    for (const [, value] of withoutFallbacks.matchAll(/box-shadow:([^;]*);/g)) {
      for (const layer of value.split(/,(?![^()]*\))/)) {
        if (!layer.includes("inset")) continue;
        expect(layer, `inset layer must follow the theme: ${layer.trim()}`)
          .not.toMatch(/rgba\(\s*(?:0,\s*0,\s*0|255,\s*255,\s*255)/);
      }
    }

    // The seat and the hero's ink specifically — the two the literals were found in.
    const seat = decls(cssRule(css, '.canvas-fleet-row[data-hero="true"] .canvas-fleet-focus'));
    // The ground is --node-floor-solid, and this line named --canvas-bg until the difference was
    // measured. Both are "the ground", but --canvas-bg is paper.fill, which is a GRADIENT on six
    // of the seven built-ins; color-mix() with a gradient is invalid at computed-value time, so
    // the seat painted nothing on those six. This assertion passed the whole time, because a
    // stylesheet match cannot see that the value it names is unusable — the same blind spot the
    // theme-var bridge tests were written for. --node-floor-solid is the same ground resolved as
    // an opaque colour per theme, so the rule the header states ("derives from a theme token")
    // is now checked against a token that actually renders.
    expect(seat).toMatch(/color-mix\([\s\S]*--node-floor-solid/);
    expect(seat, "paper.fill is a gradient — color-mix() drops the declaration")
      .not.toMatch(/color-mix\([^;]*--canvas-bg/);
    expect(seat).toMatch(/color-mix\([\s\S]*--canvas-text/);
    expect(decls(cssRule(css, '.canvas-fleet-row[data-hero="true"] .canvas-fleet-name')))
      .toMatch(/var\(--canvas-text/);

    // And the exception, stated rather than assumed: the ramp stays literal.
    expect(decls(cssRule(css, '.canvas-fleet-row[data-status="needs-you"] .canvas-fleet-edge')))
      .toMatch(/#a78bfa/);
  });

  /**
   * Smoothness is a list of properties, and the bug is always the one left off it.
   *
   * A promote moves the seat's fill, its two inset lips and the row's ink at once. Only
   * `background` was ever listed, so half the gesture eased and half of it snapped. The status edge
   * had the mirror problem: it carried `transition: background`, which had been dead since the flat
   * 2px bar became a gradient — gradients do not interpolate, so every status change stepped.
   */
  it("eases every property a promote or a status change actually moves", () => {
    const focus = decls(cssRule(css, ".canvas-fleet-focus"));
    expect(focus).toMatch(/transition:[\s\S]*background/);
    expect(focus).toMatch(/transition:[\s\S]*box-shadow/);
    expect(decls(cssRule(css, ".canvas-fleet-name"))).toMatch(/transition:[\s\S]*color/);

    // The edge transitions `color` and builds its gradient from `currentColor`, which is what makes
    // a status change cross-fade instead of snap — and keeps fill, glow and traveller in step.
    const edge = decls(cssRule(css, ".canvas-fleet-edge"));
    expect(edge).toMatch(/background:[\s\S]*currentColor/);
    expect(edge).toMatch(/transition:[\s\S]*color/);
    expect(edge).not.toMatch(/transition:[^;]*background/);
  });

  it("never reaches for the token whose fallback is the whole bug", () => {
    // `--canvas-sidebar-active` is unwritable in this app: it resolves through `--bg-elevated`,
    // which nothing defines. Reading it here again would silently reinstate the opaque slab.
    expect(decls(css)).not.toMatch(/canvas-fleet[\s\S]{0,400}var\(--canvas-sidebar-active/);
  });

  it("moves the dot out from under the close button on hover", () => {
    // The dot sat 6.4-11.4px from the row's right edge; the close button spans 4.5-22.9px from the
    // same edge, so hovering a row hid its status exactly when the operator was interacting with
    // it. Only on hover — a resting list should not spend width on a gutter for a button that is
    // not there.
    expect(css).toMatch(/\.canvas-fleet-row:hover \.canvas-fleet-focus \.cth-dot[\s\S]*?margin-right/);
  });
});
