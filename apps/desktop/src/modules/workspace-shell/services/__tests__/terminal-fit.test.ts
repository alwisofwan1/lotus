import { describe, expect, it } from "vitest";
import {
  createFitScheduler,
  hasSettledSize,
  shouldFitTerminal,
} from "@/modules/workspace-shell/services/terminal-fit";

describe("shouldFitTerminal", () => {
  it("skips a pane with no visible size, because fitting one measures nothing", () => {
    // What a hidden workspace or a pane mid-collapse looks like. xterm asked to fit a zero box
    // computes zero columns and repaints the whole buffer when the box comes back.
    expect(shouldFitTerminal({ width: 0, height: 400 })).toBe(false);
    expect(shouldFitTerminal({ width: 600, height: 0 })).toBe(false);
  });
});

describe("createFitScheduler", () => {
  it("collapses a burst of resize notifications into one fit", () => {
    // A seam drag fires a ResizeObserver entry per pointer move. Fitting on each one re-measures
    // and repaints the terminal dozens of times per second, which is what made dragging feel
    // heavy; the frame only needs the final size.
    const fits: number[] = [];
    let frame: null | (() => void) = null;
    const runFrame = () => frame?.();
    const scheduler = createFitScheduler({
      fit: () => fits.push(1),
      requestFrame: (callback) => {
        frame = callback;
        return 1;
      },
      cancelFrame: () => {
        frame = null;
      },
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(fits).toHaveLength(0);

    runFrame();
    expect(fits).toHaveLength(1);
  });
});

describe("hasSettledSize", () => {
  it("treats a size as settled only once it repeats", () => {
    // The first measurement of a pane arrives while the layout is still landing: the split tree
    // has not sized its children, the composer has not taken its height. A terminal mounted on
    // that number fits to a box it is about to stop having, and only a later resize corrects it
    // — which is why dragging the sidebar "fixed" the terminal.
    expect(hasSettledSize(null, { width: 800, height: 600 })).toBe(false);
    expect(hasSettledSize({ width: 800, height: 600 }, { width: 800, height: 600 })).toBe(true);
    expect(hasSettledSize({ width: 800, height: 600 }, { width: 800, height: 580 })).toBe(false);
  });

  it("is never settled at zero, however many times zero repeats", () => {
    expect(hasSettledSize({ width: 0, height: 0 }, { width: 0, height: 0 })).toBe(false);
  });

  it("ignores a sub-pixel wobble, which is not a real relayout", () => {
    expect(hasSettledSize({ width: 800.4, height: 600 }, { width: 800.6, height: 600 })).toBe(true);
  });
});
