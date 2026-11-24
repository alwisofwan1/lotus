import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("CanvasPage Frames wiring (LOT2-122)", () => {
  const source = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/containers/CanvasPage.tsx"), "utf8");
  // The Frame UI state and handlers live in useCanvasFrameUi; the page only wires it into the tree.
  const ui = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/hooks/useCanvasFrameUi.ts"), "utf8");

  it("decides membership on drag stop through the membership service, for any node kind", () => {
    expect(source).toMatch(/handleShapeNodeDragStop = useCallback\(\(_evt: unknown, node: Node, dragged\?: Node\[\]\) => \{\s*commitFrameDrop\(/);
    expect(source).toMatch(/membershipChangesForDrop\(nodesLatestRef\.current, dragged/);
  });

  it("lights the target Frame while dragging", () => {
    expect(source).toMatch(/canvasFrameDropStore\.set\(changes\.find\(\(c\) => c\.to\)\?\.to \?\? null\)/);
  });

  it("offers Undo in the toast through the shared history", () => {
    expect(source).toMatch(/useShapeHistory\(\{[^}]*\}\)/);
    expect(ui).toMatch(/handleFrameToastUndo[\s\S]*?undoHistory\(\)/);
    expect(source).toContain("<CanvasFrameToast");
    expect(readFileSync(resolve(process.cwd(), "src/modules/codecanvas/components/CanvasFrameToast.tsx"), "utf8")).toContain('data-testid="frame-membership-toast"');
  });

  it("keeps the viewport centre only for placing a new EMPTY Frame (new nodes join the active Frame, LOT2-135)", () => {
    expect(source).toMatch(/spawnCentreRef\.current = flowInstance/);
  });
});
