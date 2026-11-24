import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles/canvas/agent-node-persona-nl.css"), "utf8");
const bar = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/components/CanvasControlCluster.tsx"), "utf8");

/**
 * The bug this pins: the Fleet button (now the Dock button) emitted `data-active` and `aria-pressed` from the day it
 * shipped, but no stylesheet ever read the attribute — so an open Fleet panel and a closed one
 * drew the exact same muted icon. The markup was honest and the paint was not.
 */
describe("canvas-nl-icon — toggle-on state is visible, not just announced", () => {
  it("still emits the state the CSS hangs off", () => {
    expect(bar).toContain('aria-pressed={!!nav.dockOpen}');
    expect(bar).toContain('data-active={nav.dockOpen ? "true" : undefined}');
  });

  it("paints an active toggle differently from a resting one", () => {
    const start = css.indexOf('.canvas-nl-icon[data-active="true"] {');
    expect(start, "no rule reads data-active — the toggle would look dead again").toBeGreaterThan(0);
    const block = css.slice(start, css.indexOf("}", start) + 1);
    expect(block).toMatch(/background:/);
    expect(block).toMatch(/color:\s*var\(--canvas-accent/);
    expect(block).toMatch(/box-shadow:\s*inset/);
  });

  it("keeps the state on hover", () => {
    // Hovering an active toggle used to be where these regress: the plain :hover rule repaints it
    // in neutral ink, so pointing at the thing you turned on makes it look off.
    expect(css).toContain('.canvas-nl-icon[data-active="true"]:hover:not(:disabled)');
  });

  it("marks the on-state with a dot that costs no layout", () => {
    const start = css.indexOf('.canvas-nl-icon[data-active="true"]::after');
    expect(start).toBeGreaterThan(0);
    const block = css.slice(start, css.indexOf("}", start) + 1);
    expect(block).toMatch(/position:\s*absolute/);
    expect(block).not.toMatch(/\bmargin\b|\bwidth:\s*1\.7rem/);
  });

  it("drops only the motion under prefers-reduced-motion, never the state", () => {
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    const scope = css.slice(start);
    expect(scope).toContain('.canvas-nl-icon[data-active="true"]::after { animation: none }');
  });
});
