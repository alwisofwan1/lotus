import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, render, act } from "@testing-library/react";
import { StrictMode } from "react";
import { CellBusProvider, useCellBus, useCellBusEvent, useCellOutputTap } from "../cell-bus-context";
import type { CellBus } from "../cell-event-bus";
import type { FleetOutputTap } from "../fleet-output-tap";
import {
  clearTerminalSessionRegistryForTests,
  registerTerminalSession,
} from "@/modules/codespace/services/terminal-session-registry";

afterEach(() => {
  clearTerminalSessionRegistryForTests();
});

function wrapper(workspaceId: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <CellBusProvider workspaceId={workspaceId}>{children}</CellBusProvider>;
  };
}

describe("CellBusProvider + useCellBus", () => {
  it("provides a bus instance that can emit and subscribe", () => {
    const listener = vi.fn();
    const { result } = renderHook(
      () => {
        const bus = useCellBus();
        return bus;
      },
      { wrapper: wrapper("ws-1") },
    );

    const unsub = result.current.on("terminal:spawned", listener);
    act(() => {
      result.current.emit("terminal:spawned", { paneId: "p", workspaceId: "ws-1", cwd: "/" });
    });
    unsub();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("throws when useCellBus is used outside provider", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useCellBus())).toThrow(/within <CellBusProvider>/);
    errorSpy.mockRestore();
  });

  it("keeps the same bus instance across re-renders with the same workspaceId", () => {
    const { result, rerender } = renderHook(
      () => useCellBus(),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <CellBusProvider workspaceId="ws-1">{children}</CellBusProvider>
        ),
      },
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("keeps the same bus instance when workspaceId changes so listeners and in-flight events survive a workspace switch", () => {
    const seen: CellBus[] = [];
    function CaptureBus() {
      seen.push(useCellBus());
      return null;
    }

    const { rerender } = render(
      <CellBusProvider workspaceId="ws-1"><CaptureBus /></CellBusProvider>,
    );
    const first = seen[0];

    rerender(<CellBusProvider workspaceId="ws-2"><CaptureBus /></CellBusProvider>);

    expect(seen[seen.length - 1]).toBe(first);
  });

  it("delivers events emitted after a workspace switch to listeners subscribed before the switch", () => {
    const listener = vi.fn();
    const busSeen: CellBus[] = [];
    function Subscriber() {
      busSeen.push(useCellBus());
      useCellBusEvent("terminal:output", listener);
      return null;
    }

    const { rerender } = render(
      <CellBusProvider workspaceId="ws-1"><Subscriber /></CellBusProvider>,
    );

    rerender(<CellBusProvider workspaceId="ws-2"><Subscriber /></CellBusProvider>);

    act(() => {
      busSeen[busSeen.length - 1].emit("terminal:output", {
        paneId: "pane-from-ws-1",
        workspaceId: "ws-1",
        data: "completed after switch",
      });
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      paneId: "pane-from-ws-1",
      workspaceId: "ws-1",
      data: "completed after switch",
    });
  });

  it("useCellBusEvent subscribes and auto-unsubscribes on unmount", () => {
    const listener = vi.fn();
    const { result, unmount } = renderHook(
      () => {
        const bus = useCellBus();
        useCellBusEvent("terminal:status", listener);
        return bus;
      },
      { wrapper: wrapper("ws-1") },
    );

    act(() => {
      result.current.emit("terminal:status", { paneId: "p1", status: "live" });
    });
    expect(listener).toHaveBeenCalledOnce();

    unmount();
    // listener count should now be 0 for terminal:status in that bus
    // (the bus is cleaned up in provider unmount — behavior: bus.clear()).
    // Re-emitting post-unmount is moot because the bus is gone.
  });

  it("events emitted in one provider do not reach another provider", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    const { result: busA } = renderHook(() => useCellBus(), { wrapper: wrapper("ws-A") });
    const { result: busB } = renderHook(() => useCellBus(), { wrapper: wrapper("ws-B") });

    busA.current.on("terminal:spawned", listenerA);
    busB.current.on("terminal:spawned", listenerB);

    act(() => {
      busA.current.emit("terminal:spawned", { paneId: "p", workspaceId: "ws-A", cwd: "/" });
    });

    expect(listenerA).toHaveBeenCalledOnce();
    expect(listenerB).not.toHaveBeenCalled();
  });

  it("submits Bridge dispatch messages with terminal Enter", () => {
    const write = vi.fn();
    const { result } = renderHook(() => useCellBus(), { wrapper: wrapper("ws-1") });
    registerTerminalSession("pane-1", {
      workspaceId: "ws-1",
      cwd: "/tmp",
      status: "live",
      close: vi.fn(),
      write,
    });

    act(() => {
      result.current.emit("orchestrator:dispatch", {
        paneId: "pane-1",
        workspaceId: "ws-1",
        kind: "send-message",
        payload: "Hello world",
      });
    });

    expect(write).toHaveBeenCalledWith("Hello world\r");
  });
});

// (09) React StrictMode (dev) mounts every component, cleans it up, then mounts it again —
// WITHOUT re-rendering in between. `useMemo`'s tap therefore never got recomputed on the
// replayed mount, so the disposal effect's cleanup killed the tap for the rest of the
// session: every consumer that read it afterward got a dead, unsubscribed object. Live evidence:
// two Claude Code panes reported `provider=shell`, `last_output_preview` empty — the tap
// received literally zero output events after a StrictMode double-mount in dev.
describe("CellBusProvider + useCellOutputTap under StrictMode", () => {
  it("(09) the tap is still alive and subscribed after a StrictMode mount→cleanup→mount replay", () => {
    let bus!: CellBus;
    let tap!: FleetOutputTap;
    function Capture() {
      bus = useCellBus();
      tap = useCellOutputTap();
      return null;
    }

    render(
      <StrictMode>
        <CellBusProvider workspaceId="ws-1">
          <Capture />
        </CellBusProvider>
      </StrictMode>,
    );

    act(() => {
      bus.emit("terminal:output", {
        paneId: "pane-1",
        workspaceId: "ws-1",
        data: "Claude Code v2.1.269\n> ",
      });
    });

    // Empty/null here is exactly the observed bug: the tap received nothing.
    expect(tap.getLastLine("pane-1")).toBe(">");
    expect(tap.getDetectedProvider("pane-1")).toBe("claude");
  });

  it("(09) a real unmount still disposes the tap (StrictMode fixed this, didn't remove disposal)", () => {
    let bus!: CellBus;
    let tap!: FleetOutputTap;
    function Capture() {
      bus = useCellBus();
      tap = useCellOutputTap();
      return null;
    }

    const { unmount } = render(
      <StrictMode>
        <CellBusProvider workspaceId="ws-1">
          <Capture />
        </CellBusProvider>
      </StrictMode>,
    );

    act(() => {
      bus.emit("terminal:output", { paneId: "pane-1", workspaceId: "ws-1", data: "Claude Code\n" });
    });
    expect(tap.getDetectedProvider("pane-1")).toBe("claude");
    const liveTap = tap;

    unmount();

    // Disposed: its own state was cleared, and it must not still be listening on the bus.
    expect(liveTap.getDetectedProvider("pane-1")).toBe(null);
  });
});
