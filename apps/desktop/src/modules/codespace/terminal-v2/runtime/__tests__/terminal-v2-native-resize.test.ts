import { describe, expect, it, vi } from "vitest";
import { createTerminalV2NativeResizeBinding } from "../terminal-v2-native-resize";

describe("createTerminalV2NativeResizeBinding", () => {
  it("fits changed geometry and debounces PTY resize", () => {
    const schedule = vi.fn();
    const terminal = { cols: 121, rows: 33 };
    const fitAddon = { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 121, rows: 33 })) };
    const resolveResizeEvent = vi.fn(() => ({ kind: "fit" as const }));
    const layoutChanged = vi.fn();
    const lastFitted = { current: { cols: 120 as number | null, rows: 32 as number | null } };

    const binding = createTerminalV2NativeResizeBinding({
      active: true,
      fitAddon,
      lastFittedGeometryRef: lastFitted,
      resizeDebouncer: { schedule, flush: vi.fn(), cancel: vi.fn() },
      resolveResizeEvent,
      suggestionAdapter: { layoutChanged },
      terminal,
    });

    binding.performResizeFit();

    expect(resolveResizeEvent).toHaveBeenCalledWith(expect.objectContaining({
      active: true,
      lastFittedCols: 120,
      lastFittedRows: 32,
      proposedCols: 121,
      proposedRows: 33,
    }));
    expect(fitAddon.fit).toHaveBeenCalled();
    expect(lastFitted.current).toEqual({ cols: 121, rows: 33 });
    expect(schedule).toHaveBeenCalledWith(121, 33);
    expect(layoutChanged).toHaveBeenCalled();
  });

  it("leaves geometry to the visible renderer while this pane's xterm is on standby", () => {
    const schedule = vi.fn();
    const fitAddon = { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 121, rows: 33 })) };
    const resolveResizeEvent = vi.fn(() => ({ kind: "fit" as const }));
    const binding = createTerminalV2NativeResizeBinding({
      active: true,
      fitAddon,
      isRendererStandby: () => true,
      lastFittedGeometryRef: { current: { cols: 120 as number | null, rows: 32 as number | null } },
      resizeDebouncer: { schedule, flush: vi.fn(), cancel: vi.fn() },
      resolveResizeEvent,
      terminal: { cols: 121, rows: 33 },
    });

    binding.performResizeFit();

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(resolveResizeEvent).not.toHaveBeenCalled();
  });

  it("skips fit and policy work while live resize is active", () => {
    const schedule = vi.fn();
    const fitAddon = { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 121, rows: 33 })) };
    const resolveResizeEvent = vi.fn(() => ({ kind: "fit" as const }));
    const binding = createTerminalV2NativeResizeBinding({
      active: true,
      fitAddon,
      isLiveResizeActive: () => true,
      lastFittedGeometryRef: { current: { cols: 120, rows: 32 } },
      resizeDebouncer: { schedule, flush: vi.fn(), cancel: vi.fn() },
      resolveResizeEvent,
      terminal: { cols: 121, rows: 33 },
    });

    binding.performResizeFit();

    expect(resolveResizeEvent).not.toHaveBeenCalled();
    expect(fitAddon.proposeDimensions).not.toHaveBeenCalled();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("skips when geometry policy rejects fit", () => {
    const fitAddon = { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 120, rows: 32 })) };
    const binding = createTerminalV2NativeResizeBinding({
      active: true,
      fitAddon,
      lastFittedGeometryRef: { current: { cols: 120, rows: 32 } },
      resizeDebouncer: { schedule: vi.fn(), flush: vi.fn(), cancel: vi.fn() },
      resolveResizeEvent: vi.fn(() => ({ kind: "skip-fit" as const })),
      terminal: { cols: 120, rows: 32 },
    });

    binding.performResizeFit();

    expect(fitAddon.fit).not.toHaveBeenCalled();
  });
});
