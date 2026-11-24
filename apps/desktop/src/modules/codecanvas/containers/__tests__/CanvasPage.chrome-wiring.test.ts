import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Both camera-framing call sites must pass the live Layout settings into
// measureVisibleCanvasArea, so a hidden tool rail / docked top pill hands its
// strip back to the layout instead of leaving a phantom margin (the chrome
// insets are otherwise hardcoded and would keep reserving space).
describe("chrome-aware visible-area wiring", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("handleArrange measures the visible area with the current chrome state", () => {
    const source = read("src/modules/codecanvas/containers/CanvasPage.tsx");
    expect(source).toMatch(
      /measureVisibleCanvasArea\(pane\.getBoundingClientRect\(\),\s*\{\s*showToolRail:[\s\S]*?topControls:[\s\S]*?\}\)/,
    );
  });

  it("focus mode measures the visible area with the current chrome state", () => {
    const source = read("src/modules/codecanvas/hooks/useCanvasFocusMode.ts");
    expect(source).toMatch(
      /const paneRect = pane\.getBoundingClientRect\(\);\s*return measureVisibleCanvasArea\(paneRect,\s*\{\s*showToolRail:[\s\S]*?topControls:[\s\S]*?dockInset:[\s\S]*?\}\)/,
    );
    expect(source).toMatch(/getCanvasBehaviorSettings\(\)/);
  });
});
