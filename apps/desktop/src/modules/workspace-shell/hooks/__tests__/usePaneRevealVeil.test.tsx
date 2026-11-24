import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PANE_VEIL_FADE_MS, usePaneRevealVeil } from "@/modules/workspace-shell/hooks/usePaneRevealVeil";
import {
  PANE_VEIL_AFTER_REDRAW_MS,
  PANE_VEIL_BOOT_MAX_MS,
  PANE_VEIL_BOOT_QUIET_MS,
  PANE_VEIL_MAX_MS,
  PANE_VEIL_MIN_MS,
} from "@/modules/workspace-shell/services/pane-reveal-veil";
import {
  REDRAW_NUDGE_RESTORE_MS,
  resizeAndRedraw,
} from "@/modules/codespace/terminal-v2/runtime/terminal-v2-session-redraw";

type Props = { attached: boolean; maximized: boolean };

function renderVeil(initial: Props, subscribeOutput: Parameters<typeof usePaneRevealVeil>[0]["subscribeOutput"] = null) {
  return renderHook(
    ({ attached, maximized }: Props) => usePaneRevealVeil({ paneId: "pane-1", attached, maximized, subscribeOutput }),
    { initialProps: initial },
  );
}

describe("usePaneRevealVeil", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is not veiled on first mount", () => {
    const { result } = renderVeil({ attached: true, maximized: false });
    expect(result.current).toBe("off");
  });

  it("veils a just-launched pane until its first output goes quiet", () => {
    let emit: (data: string) => void = () => {};
    const subscribe = (_id: string, listener: (data: string) => void) => { emit = listener; return () => {}; };
    const { result } = renderHook(() => usePaneRevealVeil({ paneId: "pane-1", attached: true, maximized: false, subscribeOutput: subscribe, boot: true }));
    expect(result.current).toBe("on");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe("on"); // no output yet
    act(() => { emit("banner"); vi.advanceTimersByTime(PANE_VEIL_BOOT_QUIET_MS); });
    expect(result.current).toBe("out");
  });

  it("never hides a silent launched pane past the boot cap", () => {
    const { result } = renderHook(() => usePaneRevealVeil({ paneId: "pane-1", attached: true, maximized: false, subscribeOutput: null, boot: true }));
    act(() => { vi.advanceTimersByTime(PANE_VEIL_BOOT_MAX_MS); });
    expect(result.current).toBe("out");
  });

  it("veils a pane that comes back from focus mode until its PTY redraw is done", () => {
    const { result, rerender } = renderVeil({ attached: false, maximized: false });

    rerender({ attached: true, maximized: false });
    expect(result.current).toBe("on");

    // The rebuild outlasts the minimum; the veil must not lift before the redraw step.
    act(() => { vi.advanceTimersByTime(PANE_VEIL_MIN_MS + 50); });
    expect(result.current).toBe("on");

    const record = { geometry: { cols: 80, rows: 24 } };
    act(() => {
      resizeAndRedraw("pane-1", 80, 24, {
        current: () => record,
        resize: (cols, rows) => { record.geometry = { cols, rows }; },
      });
    });
    act(() => { vi.advanceTimersByTime(REDRAW_NUDGE_RESTORE_MS); });
    expect(result.current).toBe("on");

    act(() => { vi.advanceTimersByTime(PANE_VEIL_AFTER_REDRAW_MS); });
    expect(result.current).toBe("out");
    act(() => { vi.advanceTimersByTime(PANE_VEIL_FADE_MS); });
    expect(result.current).toBe("off");
  });

  it("veils the pane focus mode maximises, and again when it is restored", () => {
    const { result, rerender } = renderVeil({ attached: true, maximized: false });

    rerender({ attached: true, maximized: true });
    expect(result.current).toBe("on");
    act(() => { vi.advanceTimersByTime(PANE_VEIL_MAX_MS); });
    act(() => { vi.advanceTimersByTime(PANE_VEIL_FADE_MS); });
    expect(result.current).toBe("off");

    rerender({ attached: true, maximized: false });
    expect(result.current).toBe("on");
  });

  it("does not veil a pane focus mode is hiding", () => {
    const { result, rerender } = renderVeil({ attached: true, maximized: false });
    rerender({ attached: false, maximized: false });
    expect(result.current).toBe("off");
  });

  it("subscribes to the pane's output and unsubscribes on unmount", () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const { unmount } = renderVeil({ attached: true, maximized: false }, subscribe);

    expect(subscribe).toHaveBeenCalledWith("pane-1", expect.any(Function));
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
