import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalV2XtermEvents } from "../useTerminalV2XtermEvents";
import type { TerminalV2XtermEventAdapterOptions } from "../../rendering/terminal-v2-xterm-event-adapter";

describe("useTerminalV2XtermEvents", () => {
  it("returns a stable V2 xterm event adapter", () => {
    const dispose = vi.fn();
    const attachEvents = vi.fn(() => ({ dispose }));
    const { result, rerender } = renderHook(() => useTerminalV2XtermEvents({ attachEvents }));
    const initialAdapter = result.current;
    const request = {
      terminal: {},
      handlers: { onData: vi.fn() },
    } as TerminalV2XtermEventAdapterOptions;

    const subscription = result.current(request);
    rerender();

    expect(subscription.dispose).toBe(dispose);
    expect(attachEvents).toHaveBeenCalledWith(request);
    expect(result.current).toBe(initialAdapter);
  });
});
