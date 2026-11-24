import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(resolve(process.cwd(), "src/modules/codecanvas", rel), "utf8");

describe("Frame Overview wiring (LOT2-125)", () => {
  const page = read("containers/CanvasPage.tsx");
  const bar = read("components/CanvasControlCluster.tsx");
  const hook = read("hooks/useCanvasFrameOverview.ts");
  const frameNode = read("components/nodes/FrameNode.tsx");

  it("the grid button toggles the overview instead of opening the Canvases modal", () => {
    expect(bar).toMatch(/aria-label=\{nav\.frameOverviewOpen[^}]*\}[\s\S]*?onClick=\{nav\.onToggleFrameOverview\}/);
    expect(bar).not.toMatch(/aria-label="Browse canvases"/);
  });

  it("keeps the Canvases modal reachable from the project menu", () => {
    expect(bar).toMatch(/<CanvasProjectMenu[\s\S]*?onOpenCanvases=\{nav\.onOpenCanvases\}/);
    expect(page).toMatch(/onOpenCanvases: \(\) => setCanvasesOpen\(true\)/);
  });

  it("CanvasPage owns the overview and hands the toggle down the app-nav channel", () => {
    expect(page).toMatch(/useCanvasFrameOverview\(\{/);
    expect(page).toMatch(/onToggleFrameOverview: frameOverview\.toggle/);
    expect(page).toMatch(/<CanvasFrameOverviewLayer/);
  });

  it("keys respect the shared editable-target guard and restore the previous viewport on Esc", () => {
    expect(hook).toContain("isEditableCanvasKeyTarget(event.target)");
    expect(hook).toMatch(/event\.key === "Escape"/);
    expect(hook).toMatch(/previousViewportRef/);
  });

  it("the Overview header card counter-scales while the overview is open", () => {
    expect(frameNode).toMatch(/overviewTitleScale\(/);
    expect(frameNode).toMatch(/canvas-frame-overview-card/);
  });

  it("CanvasPage wires the Frame Grid: snap hook into the Overview, swap into the layer (LOT2-142)", () => {
    expect(page).toMatch(/useCanvasFrameGrid\(\{/);
    expect(page).toMatch(/snapFrameGrid,\s*\n\s*activeFrameId:[^\n]*\n\s*focusFrame,/);
    expect(page).toMatch(/onSwap=\{frameOverview\.swap\}/);
  });

  it("node LOD honours the Overview live-content override (decision 44)", () => {
    expect(read("hooks/useCanvasLodTier.ts")).toMatch(/canvasLodTierWithOverview\(tier, useFrameOverviewFullDetail\(\)\)/);
  });
});
