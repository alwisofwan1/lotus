import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Adaptive Ink (ADR-0033 follow-up): the terminal/agent ink-floor and the ANSI
// palette must flip for light themes. The CSS light branch keys off a
// data-canvas-mode attribute, so CanvasPage must stamp the active theme mode on
// the shell alongside data-canvas-material.
describe("adaptive-ink mode wiring", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("stamps the active theme mode on the codecanvas shell", () => {
    const source = read("src/modules/codecanvas/containers/CanvasPage.tsx");
    expect(source).toMatch(/data-canvas-mode=\{canvasTheme\.mode\}/);
  });
});
