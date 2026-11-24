import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdCanvasNodeDrag, releaseCanvasNodeDrag } from "../canvas-motion";

/**
 * The drag hold — the third member of a family that already had two.
 *
 * `data-canvas-arranging` and `data-canvas-entering` both suspend the per-node backdrop blur while
 * something moves, for the reason motion.css states plainly: re-blurring N glass panels per
 * animated frame is the most expensive part of the move in WKWebView. A pointer drag moves nodes
 * the same way and was the one motion never given the same relief — and it is the one the user
 * feels most directly, because their hand is on it.
 *
 * Unlike the other two this hold is BRACKETED, not timed: it starts on dragStart and ends on
 * dragStop. The watchdog exists only so a dropped pointer (a lost capture, a window blur mid-drag)
 * cannot leave the canvas unblurred for the rest of the session.
 */

function shell(): HTMLElement {
  return document.querySelector(".codecanvas-shell") as HTMLElement;
}

describe("holdCanvasNodeDrag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div class="codecanvas-shell"></div>`;
  });
  afterEach(() => {
    releaseCanvasNodeDrag();
    vi.useRealTimers();
  });

  it("stamps the shell for the duration of the drag and clears it on release", () => {
    holdCanvasNodeDrag();
    expect(shell().getAttribute("data-canvas-dragging")).toBe("true");
    releaseCanvasNodeDrag();
    expect(shell().hasAttribute("data-canvas-dragging")).toBe(false);
  });

  it("holds indefinitely while the drag is live — a slow drag must not un-hold mid-gesture", () => {
    holdCanvasNodeDrag();
    vi.advanceTimersByTime(4_000);
    expect(shell().getAttribute("data-canvas-dragging")).toBe("true");
  });

  it("self-heals if dragStop never arrives, so a lost pointer cannot strand the canvas", () => {
    holdCanvasNodeDrag();
    vi.advanceTimersByTime(60_000);
    expect(shell().hasAttribute("data-canvas-dragging")).toBe(false);
  });

  it("applies even when smooth animations are off — this protects the hand, not a tween", () => {
    // The arrange/enter holds no-op under data-canvas-motion="off" because they exist to keep a
    // CSS transition from starving. A drag has no transition to protect; the cost is the same.
    shell().setAttribute("data-canvas-motion", "off");
    holdCanvasNodeDrag();
    expect(shell().getAttribute("data-canvas-dragging")).toBe("true");
  });

  it("is safe to call with no canvas mounted", () => {
    document.body.innerHTML = "";
    expect(() => holdCanvasNodeDrag()).not.toThrow();
    expect(() => releaseCanvasNodeDrag()).not.toThrow();
  });
});

describe("drag hold — the CSS rule it drives", () => {
  const motionCss = readFileSync(resolve(process.cwd(), "src/styles/canvas/motion.css"), "utf8");

  it("suspends the node backdrop blur while a drag is in flight", () => {
    const rule = motionCss.match(
      /\.codecanvas-shell\[data-canvas-dragging\][^{]*\.canvas-node[^{]*\{[\s\S]*?\}/,
    )?.[0];
    expect(rule, "missing [data-canvas-dragging] .canvas-node rule").toBeTruthy();
    expect(rule).toMatch(/backdrop-filter:\s*none !important/);
    expect(rule).toMatch(/-webkit-backdrop-filter:\s*none !important/);
  });

  it("does not re-introduce a transform transition that would fight the pointer", () => {
    // motion.css already excludes `.dragging` from the position transition. A drag hold that added
    // its own transition to .react-flow__node would put the easing curve back under the hand.
    const dragRules = motionCss.match(/\.codecanvas-shell\[data-canvas-dragging\][^{]*\{[\s\S]*?\}/g) ?? [];
    for (const rule of dragRules) expect(rule).not.toMatch(/transition:/);
  });
});

describe("CanvasPage drag wiring", () => {
  const source = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/containers/CanvasPage.tsx"), "utf8");

  it("brackets the hold with ReactFlow's own drag lifecycle", () => {
    expect(source).toMatch(/onNodeDragStart=\{[^}]*handleNodeDragStart/);
    expect(source).toMatch(/holdCanvasNodeDrag\(\)/);
    expect(source).toMatch(/releaseCanvasNodeDrag\(\)/);
  });

  it("keeps the injected node/edge identity path — the other half of drag smoothness", () => {
    expect(source).toMatch(/createCanvasFlowInjector\(\)/);
    expect(source).toMatch(/nodes=\{flowInjector\.nodes\(/);
    expect(source).toMatch(/edges=\{flowInjector\.edges\(/);
    // Calling the pure builders inline is what rebuilt every node's data every frame.
    expect(source).not.toMatch(/nodes=\{injectCanvasNodeCallbacks\(/);
  });
});
