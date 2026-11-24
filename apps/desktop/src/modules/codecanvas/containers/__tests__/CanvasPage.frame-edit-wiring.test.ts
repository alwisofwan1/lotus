import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("CanvasPage Frame create/edit wiring (LOT2-123)", () => {
  const source = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/containers/CanvasPage.tsx"), "utf8");
  // The Frame UI state and handlers live in useCanvasFrameUi; the page only wires it into the tree.
  const ui = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/hooks/useCanvasFrameUi.ts"), "utf8");

  it("Cmd+G uses the shared editable-target guard and only swallows the key when it acts (audit A#6)", () => {
    expect(source).toMatch(/key\.toLowerCase\(\) !== "g"\) return;\s*if \(isEditableCanvasKeyTarget\(event\.target\)\) return;/);
    expect(source).toMatch(/if \(!groupEligible\) return;\s*event\.preventDefault\(\);\s*handleGroup\(\);/);
    expect(source).not.toMatch(/target\.tagName === "INPUT" \|\| target\.tagName === "TEXTAREA" \|\| target\.isContentEditable\)\) return;\s*event\.preventDefault\(\);\s*if \(event\.shiftKey\)/);
  });

  it("a Frame made from the selection opens its title for typing", () => {
    expect(source).toMatch(/const frameId = createFrame\(selectedNodes\.map\(\(n\) => n\.id\)\);\s*[^]*?if \(frameId\) canvasFrameEditStore\.request\(frameId\)/);
  });

  it("F2 renames the single selected Frame", () => {
    expect(source).toMatch(/event\.key !== "F2"/);
    expect(source).toMatch(/selectedFrames\.length !== 1\) return;[^]*?canvasFrameEditStore\.request\(selectedFrames\[0\]\.id\)/);
  });

  it("the Frame tool draws through its own capture layer and returns to select", () => {
    expect(source).toMatch(/activeTool === "frame" && flowInstance \? \(\s*<CanvasFrameDrawCapture/);
    expect(ui).toMatch(/addFrameInBox\(box\);\s*onToolDone\(\)/);
    expect(source).toMatch(/onToolDone: \(\) => setActiveTool\("select"\)/);
  });

  it("the selection toolbar sits inside the canvas and reuses the Cmd+G handler", () => {
    expect(source).toMatch(/<CanvasFrameSelectionToolbar nodeIds=\{frameSelectionIds\} onCreateFrame=\{handleGroup\}/);
  });

  it("the tab '+' spawns into the Frame through the shared command path", () => {
    expect(ui).toMatch(/kind: "create-node", nodeType: "terminal", frameId/);
    expect(ui).toMatch(/options: \{ teamLabel, frameId \}/);
  });

  it("Delete with contents ends sessions, then forgets undo history once the removal has landed", () => {
    expect(ui).toMatch(/Promise\.resolve\(deleteFrameAndContents\(frameDeleteTarget\)\)\.finally\(clearHistory\)/);
    expect(source).toMatch(/<CanvasFrameDeleteDialog/);
  });

  it("the first-Frame hint is gated by the pure rule and persisted once", () => {
    expect(ui).toMatch(/shouldShowFirstFrameHint\(nodes, firstFrameHintSeen\)/);
    expect(ui).toMatch(/markFirstFrameHintSeen\(\)/);
  });
});
