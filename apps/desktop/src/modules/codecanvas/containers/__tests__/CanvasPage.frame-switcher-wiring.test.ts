import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("CanvasPage Frame Switcher wiring (LOT2-124)", () => {
  const source = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/containers/CanvasPage.tsx"), "utf8");
  // The Frame UI state and handlers live in useCanvasFrameUi; the page only wires it into the tree.
  const ui = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/hooks/useCanvasFrameUi.ts"), "utf8");

  it("builds chips from the live nodes and agent status roster", () => {
    expect(ui).toMatch(/buildFrameSwitcher\(nodes, liveAgentStatuses\)/);
  });

  it("hands the same chips to the command bar and the Top Bar", () => {
    expect(source).toMatch(/const frameSwitcherProps = \{[^}]*chips: frameSwitcher\.chips/);
    expect(source.match(/frameSwitcher=\{frameSwitcherProps\}/g)).toHaveLength(2);
  });

  // Decision 35 (LOT2-134): focusing a Frame fills the screen. Every fly path ends in ONE function.
  const overview = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/hooks/useCanvasFrameOverview.ts"), "utf8");

  it("goToFrame delegates to focusFrame and no longer fits the padded Frame box", () => {
    expect(ui).toMatch(/const goToFrame = useCallback\(\(frameId: string\) => \{[^]*?focusFrame\(frameId\);/);
    expect(ui).not.toMatch(/fitBounds/);
    expect(ui).not.toMatch(/padding: 0\.12/);
  });

  it("chips, hotkeys, NL commands and Overview all reach focusFrame", () => {
    // chips: onGoToFrame = goToFrame; hotkeys: goToFrameAt -> goToFrame; NL: fly-to-frame -> goToFrame
    expect(source).toMatch(/onGoToFrame: goToFrame/);
    expect(ui).toMatch(/const goToFrameAt = \(index: number\) => \{[^]*?goToFrame\(id\)/);
    expect(ui).toMatch(/command\.kind === "fly-to-frame"\) \{\s*goToFrame\(command\.frameId\)/);
    // Overview fly-in / Enter: flyIn -> focusFrame (the same function the page hands to useCanvasFrameUi)
    expect(overview).toMatch(/close\(false\);\s*focusFrame\(frameId\);/);
    expect(source).toMatch(/useCanvasFrameOverview\(\{[^}]*focusFrame,/);
    expect(source).toMatch(/useCanvasFrameUi\(\{[^}]*frameCommandRef, focusFrame/);
  });

  it("focusFrame arranges only the Frame's members, then frames the box exactly like Arrange", () => {
    // focusFrame moved into useCanvasFrameFocus (LOT2-135) with the same arrange + frame rule.
    const focus = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/hooks/useCanvasFrameFocus.ts"), "utf8");
    // The area less the room an open Run Node's outline needs (#74); zero margin = the whole area.
    expect(focus).toMatch(/arrangeFrameMembers\(frameId, fitInsideRunMargin\(area, margin\)\)/);
    expect(focus).toMatch(/boundsWithRunMargin\(grid, margin\)/);
    expect(focus).toMatch(/const target = frameBoundsInVisibleArea\(bounds, area\);/);
    expect(focus).toMatch(/fitBounds\(frameBounds\(frame\), \{ padding: 0, duration/);
  });

  it("registers a go and a move handler for every chip slot through the hotkey registry", () => {
    expect(source).toMatch(/"frame-go-1": \(\) => goToFrameAt\(1\)/);
    expect(source).toMatch(/"frame-go-9": \(\) => goToFrameAt\(9\)/);
    expect(source).toMatch(/"frame-move-1": \(\) => moveSelectionToFrameAt\(1\)/);
    expect(source).toMatch(/"frame-move-9": \(\) => moveSelectionToFrameAt\(9\)/);
  });

  it("moves the selection through the membership service and offers the same Undo toast", () => {
    // The nodes move INSIDE the Frame too (sendNodesToFrame), and the toast's Undo restores all of it.
    expect(ui).toMatch(/sendNodesToFrame\(ids, frameId\);[^]*?offerMembershipToast\(\[\.\.\.result\.changes\], \{ text, undo: result\.undo \}\)/);
    expect(ui).toMatch(/framesInOrder\(nodesLatestRef\.current\)\[index - 1\]/);
  });

  it("creates the new Frame at the viewport centre", () => {
    expect(ui).toMatch(/addEmptyFrame\(spawnCentreRef\.current\?\.\(\)/);
  });
});
