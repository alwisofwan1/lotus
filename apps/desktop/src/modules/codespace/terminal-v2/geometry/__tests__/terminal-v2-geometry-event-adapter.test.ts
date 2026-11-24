import { describe, expect, it, vi } from "vitest";
import {
  createTerminalV2PtyResizeDebouncer,
  resolveTerminalV2CommitFitEvent,
  resolveTerminalV2InitialGeometryEvent,
  resolveTerminalV2ResizeEvent,
} from "../terminal-v2-geometry-event-adapter";

describe("Terminal V2 geometry event adapter", () => {
  it("ignores resize work when pane is inactive or live-resizing", () => {
    expect(resolveTerminalV2ResizeEvent({
      active: false,
      liveResizeActive: false,
      lastFittedCols: null,
      lastFittedRows: null,
    })).toEqual({ kind: "ignore", reason: "inactive" });

    expect(resolveTerminalV2ResizeEvent({
      active: true,
      liveResizeActive: true,
      lastFittedCols: null,
      lastFittedRows: null,
    })).toEqual({ kind: "ignore", reason: "live-resize" });
  });

  it("skips expensive fit when proposed dimensions match the last fitted geometry", () => {
    expect(resolveTerminalV2ResizeEvent({
      active: true,
      liveResizeActive: false,
      lastFittedCols: 120,
      lastFittedRows: 32,
      proposedCols: 120,
      proposedRows: 32,
    })).toEqual({ kind: "skip-fit" });
  });

  it("requests fit when geometry is active and changed or unknown", () => {
    expect(resolveTerminalV2ResizeEvent({
      active: true,
      liveResizeActive: false,
      lastFittedCols: 120,
      lastFittedRows: 32,
      proposedCols: 121,
      proposedRows: 32,
    })).toEqual({ kind: "fit" });
  });

  it("defers session start until initial geometry is valid", () => {
    expect(resolveTerminalV2InitialGeometryEvent(null)).toEqual({ kind: "defer-start" });
    expect(resolveTerminalV2InitialGeometryEvent({ cols: 100, rows: 30, width: 900, height: 480 })).toEqual({
      kind: "start-session",
      geometry: { cols: 100, rows: 30, width: 900, height: 480 },
    });
  });

  it("authorizes commit fit only for active panes", () => {
    expect(resolveTerminalV2CommitFitEvent({ active: false })).toEqual({ kind: "ignore", reason: "inactive" });
    expect(resolveTerminalV2CommitFitEvent({ active: true })).toEqual({ kind: "fit-and-flush" });
  });

  it("debounces PTY resize and flushes the latest geometry immediately on commit", () => {
    vi.useFakeTimers();
    const onResize = vi.fn();
    const debouncer = createTerminalV2PtyResizeDebouncer({ onResize });

    debouncer.schedule(100, 30);
    debouncer.schedule(120, 40);
    vi.advanceTimersByTime(255);
    expect(onResize).not.toHaveBeenCalled();

    debouncer.flush();
    vi.advanceTimersByTime(1);

    expect(onResize).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledWith(120, 40);
    vi.useRealTimers();
  });
});
