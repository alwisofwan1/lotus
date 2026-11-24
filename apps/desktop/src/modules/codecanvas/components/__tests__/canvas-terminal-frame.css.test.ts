import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Canvas Terminal revamp (plans/canvas-terminal-revamp) — the frame contract for the two live
 * node families (Terminal Node + Live Agent Terminal).
 *
 * The mockup rests on three rules, and each one is a thing this suite can actually check:
 *   1. The frame is QUIET. One neutral glass rim from the theme — no permanent accent border and
 *      no accent halo baked into the resting box-shadow. Accent belongs to hover/selection only,
 *      otherwise every idle node on the canvas glows for no reason.
 *   2. NO LINES INSIDE THE NODE. The header carries no fill and no bottom hairline; header/body
 *      separation is pure luminance (the body's ink floor sits over the same glass). Over a photo
 *      wallpaper a hairline reads as a crack, a luminance step reads as depth.
 *   3. The spawn sheen is COMPOSITOR-ONLY. `.canvas-node` carries a backdrop-filter, so animating
 *      anything but transform/opacity re-blurs the backdrop every frame — the same reasoning the
 *      enter/leave keyframes already follow (see canvas-node-enter-motion.css.test.ts).
 */

function read(name: string): string {
  return readFileSync(resolve(process.cwd(), `src/styles/canvas/${name}`), "utf8");
}

/** Grab a top-level rule by its exact (possibly multi-line) selector list. */
function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match, `missing rule: ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

/** Strip comments so bans assert on declarations, not on prose that merely names a token. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const nodeShell = read("node-shell.css");
const terminalCss = read("terminal-node.css");
const personaCss = read("agent-node-persona-nl.css");
const themeCss = read("theme.css");

describe("canvas terminal frame — glass background and border", () => {
  const frame = stripCssComments(
    cssRule(nodeShell, ".canvas-node.canvas-agent-node,\n.canvas-node.canvas-terminal-node"),
  );

  it("takes its resting fill, rim, and shadow from the theme's glass tokens", () => {
    expect(frame).toMatch(/background:\s*var\(--node-glass-bg\)/);
    expect(frame).toMatch(/border-color:\s*var\(--node-rest-rim\)/);
    // The rim is the glass edge with a calm theme tint: well under selection's 50% accent.
    const rim = nodeShell.match(/--node-rest-rim:\s*color-mix\(in oklab, var\(--canvas-accent\) (\d+)%, var\(--node-glass-border\)\)/);
    expect(Number(rim?.[1])).toBeLessThanOrEqual(25);
    expect(frame).toMatch(/box-shadow:\s*var\(--node-glass-shadow\),\s*var\(--node-glass-inset\)/);
  });

  it("carries no accent tint in the resting rim and no accent halo in the resting shadow", () => {
    // Rule 1: an idle node must not advertise. Its rim may carry a calm theme tint (via
    // --node-rest-rim, above), but no accent ring or bloom rides in the box-shadow.
    expect(frame).not.toMatch(/box-shadow:[^;]*--canvas-accent/);
    expect(frame).not.toMatch(/box-shadow:[^;]*--node-accent/);
  });

  it("frosts through a single bounded token instead of a hardcoded, backdrop-darkening blur", () => {
    expect(frame).toMatch(/backdrop-filter:\s*var\(--node-live-filter\)/);
    expect(frame).toMatch(/-webkit-backdrop-filter:\s*var\(--node-live-filter\)/);
    // Bounded radius: these are the heaviest nodes in the app and they frost while RESTING, so the
    // radius stays in the cheap range even though the theme's own glass filter is 22px.
    const token = themeCss.match(/--node-live-filter:[^;]+;/)?.[0] ?? "";
    expect(token, "missing --node-live-filter in theme.css").not.toBe("");
    const radius = Number(token.match(/blur\((\d+)px\)/)?.[1] ?? "999");
    expect(radius).toBeLessThanOrEqual(18);
    // …and it must LIFT the backdrop, not darken it — brightness < 1 is what made the old frame
    // read as a muddy slab instead of glass over the wallpaper.
    const brightness = Number(token.match(/brightness\(([\d.]+)\)/)?.[1] ?? "0");
    expect(brightness).toBeGreaterThanOrEqual(1);
  });

  it("keeps the body ink floor translucent and neutral so the glass still reads underneath", () => {
    const shell = stripCssComments(cssRule(nodeShell, ".canvas-node"));
    const surface = shell.match(/--node-surface:[^;]+;/)?.[0] ?? "";
    expect(surface).toMatch(/--node-surface-ink/);
    expect(surface).toMatch(/transparent/);
    // Neutral: no per-kind accent tint mixed into the terminal floor (the badge owns identity).
    expect(surface).not.toMatch(/--node-accent/);
  });
});

describe("canvas terminal frame — no lines inside the node", () => {
  it("styles the inline terminal-name editor as compact header chrome", () => {
    const input = stripCssComments(cssRule(terminalCss, ".cth-name-input"));
    expect(input).toMatch(/font-size:\s*0\.6875rem/);
    expect(input).toMatch(/border:\s*1px solid/);
    expect(input).toMatch(/min-width:\s*0/);
  });

  it("gives the terminal header no fill and no bottom hairline", () => {
    const row = stripCssComments(cssRule(terminalCss, ".cth-row1"));
    expect(row).toMatch(/background:\s*transparent/);
    expect(row).not.toMatch(/--node-header-bg/);
    expect(row).not.toMatch(/border-bottom:\s*1px/);
  });

  it("gives the live-agent persona header the same treatment", () => {
    const header = stripCssComments(cssRule(personaCss, ".canvas-persona-header"));
    // The "bare glass" half of this contract was RETIRED deliberately: the persona header now
    // carries a gilded band and a bottom hairline. It dissolved into the node by design, which
    // worked while every theme was dark and the body's ink floor supplied the separation — on a
    // light theme header and body are both pale, so "no separation" became "no header".
    //
    // What still holds, and is what this test is really for: the band is derived from the node's
    // OWN edge token, never from --node-header-bg (a token nothing consumes — see the comment in
    // node-shell.css) and never from a literal colour. A hex here would be a per-theme decision
    // smuggled into a shared rule, which is the bug class this file exists to catch.
    expect(header).toMatch(/background:\s*linear-gradient/);
    expect(header).toMatch(/--node-glass-border/);
    expect(header).not.toMatch(/--node-header-bg/);
    expect(header).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("drops the inset hairline that capped the top of the terminal viewport", () => {
    const viewport = stripCssComments(cssRule(terminalCss, ".canvas-terminal-viewport"));
    expect(viewport).not.toMatch(/box-shadow:\s*inset/);
  });

  it("keeps the live-agent viewport on the shared floor (no regression)", () => {
    // Was --node-surface, a 34% ink wash under a transparent xterm. The floor is opaque now
    // (plans/canvas-terminal-opaque-floor) and xterm paints the same colour, so the two cannot
    // show a seam. What this still guards is that the viewport has a DEFINED ground at all.
    expect(cssRule(terminalCss, ".canvas-agent-node .canvas-terminal-viewport")).toMatch(
      /background:\s*var\(--node-floor-solid\)/,
    );
  });
});

describe("canvas terminal frame — accent follows the theme role", () => {
  it("no longer pins the terminal accent to theme-independent status hexes", () => {
    // The per-status hex overrides took the Terminal Node out of every theme's palette. Status is
    // carried by the header dot and the runner badge; the accent stays the theme's `info` role.
    expect(stripCssComments(nodeShell)).not.toMatch(
      /\.canvas-terminal-node\[data-node-status="(?:idle|running|starting|failed)"\]\s*\{[^}]*--node-accent:\s*#/,
    );
  });

  it("still resolves the terminal accent from the theme's info role", () => {
    // Unchanged in effect, one link longer in form. The accent now goes through the canonical
    // node-type table (--canvas-type-*) so the Fleet row for a terminal can paint its icon the
    // same colour without a second copy of "terminal is the info role". Verified in a browser:
    // the terminal accent still computes to #306ca2 on Garden of Dawn, which IS --canvas-node-info.
    //
    // BOTH links are asserted, so the indirection cannot quietly become a different colour —
    // repointing --canvas-type-terminal at some other role fails here, which is the whole point
    // of checking the chain rather than just the endpoint.
    expect(cssRule(nodeShell, ".canvas-terminal-node")).toMatch(
      /--node-accent:\s*var\(--canvas-type-terminal\)/,
    );
    expect(read("theme.css")).toMatch(/--canvas-type-terminal:\s*var\(--canvas-node-info\)/);
  });
});

describe("canvas terminal frame — spawn sheen", () => {
  // Resolved per-test, not at collection time: a missing rule should fail one assertion, not
  // blow up the whole file before a single test is reported.
  const layer = () => cssRule(terminalCss, ".canvas-node-sheen");
  const band = () => cssRule(terminalCss, ".canvas-node-sheen::before");
  const keyframes = () => terminalCss.match(/@keyframes canvas-node-sheen\s*\{[\s\S]*?\n\}/)?.[0] ?? "";

  it("clips the sweep itself, because .canvas-node is overflow:visible for floating panels", () => {
    const sheen = layer();
    expect(sheen).toMatch(/overflow:\s*hidden/);
    expect(sheen).toMatch(/border-radius:\s*inherit/);
    expect(sheen).toMatch(/pointer-events:\s*none/);
  });

  it("animates transform and opacity only — never a property that repaints the backdrop", () => {
    const frames = keyframes();
    expect(frames, "missing @keyframes canvas-node-sheen").not.toBe("");
    expect(frames).toMatch(/transform:\s*translate3d/);
    expect(frames).toMatch(/opacity/);
    expect(frames).not.toMatch(/border-radius/);
    expect(frames).not.toMatch(/blur|filter|background/);
  });

  it("rides the same enter-burst stagger as the node landing, so a burst flows", () => {
    expect(band()).toMatch(/animation-delay:\s*calc\([^;]*--canvas-enter-delay/);
  });

  it("plays once — a looping highlight on a live terminal would never stop pulling the eye", () => {
    expect(band()).not.toMatch(/infinite/);
  });

  it("is fully disabled under prefers-reduced-motion", () => {
    expect(terminalCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.canvas-node-sheen::before[\s\S]*?animation:\s*none/,
    );
  });
});
