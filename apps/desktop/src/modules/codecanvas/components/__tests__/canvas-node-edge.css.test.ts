import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The node's top accent is part of its edge, not a bar laid across it.
 *
 * It shipped as a 1px-tall box pinned to `top/left/right: 0` with a `12px 12px 0 0` radius, which
 * fails twice over: a border-radius cannot survive a 1px-tall box (the spec scales the radii down
 * to fit, so the ends render square), and `.canvas-node` is deliberately `overflow: visible` so
 * floating panels can escape its bounds — so nothing clipped those square ends back to the rounded
 * silhouette. The accent ran the full width of the node's SQUARE bounds, crossed both corner arcs
 * and overhung the wallpaper.
 *
 * On a dark board that reads as a hairline. On Garden of Dawn's bright paper it reads as a stray
 * strip across the top of every node, which is how it was reported.
 */
const css = readFileSync(
  resolve(process.cwd(), "src/styles/canvas/node-shell.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(m, `missing rule: ${selector}`).not.toBeNull();
  return m?.[0] ?? "";
};

describe("node top accent", () => {
  const accent = rule(".canvas-node::after");

  it("spans the whole box so its radius can match the node's", () => {
    expect(accent).toMatch(/inset:\s*0/);
    expect(accent).toMatch(/border-radius:\s*inherit/);
  });

  it("is drawn as a border edge, not a filled bar", () => {
    expect(accent).toMatch(/border-top:\s*1px solid var\(--node-accent\)/);
    // The two properties that made it a bar. A fixed height re-creates the radius-collapse, and a
    // background fill would paint the node's whole face at inset: 0.
    expect(accent, "a height turns this back into a bar").not.toMatch(/height:/);
    expect(accent, "at inset: 0 a background would cover the node").not.toMatch(/background:/);
  });

  it("still relies on opacity alone for its states, which the variants set", () => {
    // .selected / :focus-within / :hover / .canvas-agent-node all change only opacity or display,
    // so the shape change above cannot break them — but only while this stays true.
    expect(accent).toMatch(/opacity:\s*0\.5/);
    expect(rule(".canvas-node.selected::after,\n.canvas-node:focus-within::after")).toMatch(
      /opacity:\s*1/,
    );
    expect(css).toMatch(/\.canvas-agent-node::after\s*\{\s*display:\s*none/);
  });

  it("documents why clipping cannot be the fix", () => {
    // If the node ever became `overflow: hidden`, the bar would have been clipped and this whole
    // rule could go back to being a bar. It is visible on purpose — floating panels escape it.
    expect(rule(".canvas-node")).toMatch(/overflow:\s*visible/);
  });
});
