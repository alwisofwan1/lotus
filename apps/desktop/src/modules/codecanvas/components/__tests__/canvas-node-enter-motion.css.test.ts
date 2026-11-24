import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const nodeShell = readFileSync(resolve(process.cwd(), "src/styles/canvas/node-shell.css"), "utf8");
const motion = readFileSync(resolve(process.cwd(), "src/styles/canvas/motion.css"), "utf8");

function block(css: string, header: string): string {
  const start = css.indexOf(header);
  expect(start, `missing block: ${header}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated block: ${header}`);
}

/**
 * The node mount animation is the transition the user sees on every voice-driven spawn. It must be
 * compositor-friendly: `border-radius` is not a compositable property, so animating it repaints the
 * node every frame — and because `.canvas-node` carries a backdrop-filter, every repaint also re-blurs
 * the backdrop. The leave animation already avoids exactly this (see its comment in node-shell.css);
 * these tests hold the enter path to the same bar.
 */
describe("canvas node enter motion is compositor-friendly", () => {
  it("animates only opacity and transform — never border-radius — in the enter keyframes", () => {
    const keyframes = block(nodeShell, "@keyframes canvas-node-enter");
    expect(keyframes).not.toMatch(/border-radius/);
    expect(keyframes).toMatch(/opacity/);
    expect(keyframes).toMatch(/transform/);
  });

  it("keeps the leave keyframes free of border-radius too (no regression)", () => {
    expect(block(nodeShell, "@keyframes canvas-node-leave")).not.toMatch(/border-radius/);
  });

  it("suspends the per-node backdrop blur while a node is entering, mirroring the arrange hold", () => {
    const suspend = block(motion, ".codecanvas-shell[data-canvas-entering] .canvas-node");
    expect(suspend).toMatch(/backdrop-filter:\s*none\s*!important/);
    expect(suspend).toMatch(/-webkit-backdrop-filter:\s*none\s*!important/);
    // Promote for the duration of the mount, the same way the arrange hold does for its glide.
    expect(suspend).toMatch(/will-change:\s*transform,\s*opacity/);
  });

  it("scopes the enter hold to the shell attribute the JS helper stamps, so there is one lifecycle", () => {
    const helper = readFileSync(
      resolve(process.cwd(), "src/modules/codecanvas/services/canvas-motion.ts"),
      "utf8",
    );
    expect(helper).toMatch(/setAttribute\("data-canvas-entering", "true"\)/);
    expect(helper).toMatch(/removeAttribute\("data-canvas-entering"\)/);
  });
});
