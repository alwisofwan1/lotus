import { describe, expect, it, vi } from "vitest";
import { paintReattachedTerminalView } from "../live-agent-terminal-paint";

describe("paintReattachedTerminalView", () => {
  it("sizes the grid and PTY before painting buffered output (fit → resize → ready → flush)", () => {
    const order: string[] = [];
    const resizePty = vi.fn((cols: number, rows: number) => order.push(`resize:${cols}x${rows}`));

    paintReattachedTerminalView({
      fit: () => order.push("fit"),
      // Size is read AFTER fit, so it reflects the fitted grid, not the default 80x24.
      size: () => ({ cols: 200, rows: 50 }),
      resizePty,
      markReady: () => order.push("ready"),
      flushPending: () => order.push("flush"),
    });

    expect(order).toEqual(["fit", "resize:200x50", "ready", "flush"]);
    expect(resizePty).toHaveBeenCalledWith(200, 50);
  });

  it("marks the terminal ready before flushing so buffered output lands in a sized grid", () => {
    const events: string[] = [];
    paintReattachedTerminalView({
      fit: () => {},
      size: () => ({ cols: 120, rows: 30 }),
      resizePty: () => {},
      markReady: () => events.push("ready"),
      flushPending: () => events.push("flush"),
    });
    expect(events.indexOf("ready")).toBeLessThan(events.indexOf("flush"));
  });
});
