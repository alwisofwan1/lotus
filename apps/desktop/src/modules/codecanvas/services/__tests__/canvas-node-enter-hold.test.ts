import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { CANVAS_MOTION, holdCanvasNodeEnter, canvasNodeEnterHoldMs } from "../canvas-motion";
import { resetCanvasBehaviorStoreForTests, setCanvasBehaviorSetting } from "../../hooks/useCanvasBehaviorSettings";

/**
 * The node mount animation repaints a backdrop-filtered glass panel. `holdCanvasNodeEnter` suspends
 * that blur for the length of the enter — the same trick `holdCanvasArrangeGlide` uses for the arrange
 * glide — so a spawning Terminal/Agent node does not re-blur N panels on every frame of its own entrance.
 */
describe("holdCanvasNodeEnter", () => {
  let shell: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    resetCanvasBehaviorStoreForTests();
    shell = document.createElement("div");
    shell.className = "codecanvas-shell";
    document.body.appendChild(shell);
  });

  afterEach(() => {
    vi.useRealTimers();
    shell.remove();
  });

  it("stamps data-canvas-entering on the shell and clears it once the enter finishes", () => {
    holdCanvasNodeEnter(0);
    expect(shell.getAttribute("data-canvas-entering")).toBe("true");

    vi.advanceTimersByTime(canvasNodeEnterHoldMs(0));
    expect(shell.hasAttribute("data-canvas-entering")).toBe(false);
  });

  it("covers the stagger delay too, so the LAST node of a burst still enters unblurred", () => {
    const staggered = canvasNodeEnterHoldMs(256);
    expect(staggered).toBeGreaterThan(canvasNodeEnterHoldMs(0));
    expect(staggered).toBeGreaterThanOrEqual(256 + CANVAS_MOTION.enterMs);
  });

  it("extends an in-flight hold rather than letting an earlier node's timer cut it short", () => {
    holdCanvasNodeEnter(0);
    vi.advanceTimersByTime(canvasNodeEnterHoldMs(0) - 20);
    holdCanvasNodeEnter(256);
    vi.advanceTimersByTime(40);
    expect(shell.getAttribute("data-canvas-entering")).toBe("true");

    vi.advanceTimersByTime(canvasNodeEnterHoldMs(256));
    expect(shell.hasAttribute("data-canvas-entering")).toBe(false);
  });

  it("is a no-op when canvas motion is off — nothing to unblur if nothing animates", () => {
    setCanvasBehaviorSetting("canvasAnimations", false);
    holdCanvasNodeEnter(0);
    expect(shell.hasAttribute("data-canvas-entering")).toBe(false);
  });
});
