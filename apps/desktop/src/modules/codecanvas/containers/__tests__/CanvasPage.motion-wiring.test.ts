import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("CanvasPage motion wiring", () => {
  const source = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/containers/CanvasPage.tsx"), "utf8");

  it("routes node-view close actions through the command center leave animation path", () => {
    expect(source).toMatch(/closeNode:\s*\(nodeId\)\s*=>\s*runCanvasCommand\(\{\s*kind:\s*"close-node",\s*nodeId\s*\}\)/);
    expect(source).not.toMatch(/closeNode:\s*handleClose/);
  });

  it("coordinates arrange camera motion with the node glide instead of delayed catch-up", () => {
    expect(source).toContain("move the camera WITH the node glide");
    // The blur suspension + pre-commit layout flush live in the shared glide helper now
    // (holdCanvasArrangeGlide in canvas-motion.ts) so arrange and focus mode ride one rule.
    expect(source).toMatch(/holdCanvasArrangeGlide\(duration\)/);
    const motionSource = readFileSync(
      resolve(process.cwd(), "src/modules/codecanvas/services/canvas-motion.ts"),
      "utf8",
    );
    expect(motionSource).toMatch(/shell\.getBoundingClientRect\(\)/);
    expect(source).toMatch(/Math\.max\(ARRANGE_ANIM_MS, CANVAS_MOTION\.reframeMs\)[\s\S]*?runCanvasViewportMotion\([\s\S]*?flowInstance\.setViewport\([\s\S]*?canvasEaseOutQuint/);
    expect(source).not.toMatch(/setTimeout\(\(\) => \{\s*flowInstance\.setViewport/);
  });

  it("does not ship the temporary motion debug overlay", () => {
    expect(source).not.toContain(`DEBUG-${"cnvmo"}`);
    expect(source).not.toContain(`CanvasMotion${"DebugBadge"}`);
  });
});
