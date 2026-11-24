import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_V2_RENDERER_DIAGNOSTICS_STORAGE_KEY,
  useTerminalV2RendererDiagnostics,
  useTerminalV2RendererDiagnosticsEnabled,
  useTerminalV2RuntimeDiagnostics,
} from "../useTerminalV2RendererDiagnostics";
import type { TerminalV2RendererDebugSnapshot } from "../../rendering/terminal-v2-renderer-coordinator";

const snapshot: TerminalV2RendererDebugSnapshot = {
  leases: [],
  registeredSlots: ["pane-1"],
  waitingPanes: ["pane-2"],
  fallbackPanes: [],
};

describe("useTerminalV2RendererDiagnostics", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("enables the development diagnostics panel from localStorage", () => {
    window.localStorage.setItem(TERMINAL_V2_RENDERER_DIAGNOSTICS_STORAGE_KEY, "1");

    const { result } = renderHook(() => useTerminalV2RendererDiagnosticsEnabled("development"));

    expect(result.current).toBe(true);
  });

  it("refreshes the renderer debug snapshot on an interval", () => {
    vi.useFakeTimers();
    const first: TerminalV2RendererDebugSnapshot = { leases: [], registeredSlots: [], waitingPanes: ["pane-1"], fallbackPanes: [] };
    const second: TerminalV2RendererDebugSnapshot = { leases: [], registeredSlots: ["pane-2"], waitingPanes: [], fallbackPanes: [] };
    const runtime = { getRendererDebugSnapshot: vi.fn(() => first) };

    const { result } = renderHook(() => useTerminalV2RendererDiagnostics({
      enabled: true,
      environment: "development",
      runtime,
      refreshMs: 250,
    }));

    runtime.getRendererDebugSnapshot.mockReturnValue(second);
    act(() => vi.advanceTimersByTime(250));

    expect(result.current).toEqual(second);
  });

  it("returns a renderer debug snapshot only when enabled outside production", () => {
    const runtime = { getRendererDebugSnapshot: vi.fn(() => snapshot) };

    const { result } = renderHook(() => useTerminalV2RendererDiagnostics({
      enabled: true,
      environment: "development",
      runtime,
    }));

    expect(result.current).toEqual(snapshot);
    expect(runtime.getRendererDebugSnapshot).toHaveBeenCalled();
  });

  it("returns the broader runtime diagnostics snapshot when available", () => {
    const diagnostics = {
      renderer: snapshot,
      sessions: { total: 2, byStatus: { running: 1, detached: 1 }, byWorkspace: { "workspace-a": 2 } },
      counters: {
        rendererVisibilityUpdates: 3,
        rendererOutputBytes: 42,
        paneInputWrites: 1,
        paneResizeRequests: 2,
        pooledInputWrites: 1,
      },
      knownPaneCount: 4,
      startedAt: 123,
    };
    const runtime = { getRuntimeDiagnosticsSnapshot: vi.fn(() => diagnostics) };

    const { result } = renderHook(() => useTerminalV2RuntimeDiagnostics({
      enabled: true,
      environment: "development",
      runtime,
    }));

    expect(result.current).toEqual(diagnostics);
  });

  it("does not poll or read runtime diagnostics when disabled or in production", () => {
    vi.useFakeTimers();
    const runtime = { getRuntimeDiagnosticsSnapshot: vi.fn() };

    const disabled = renderHook(() => useTerminalV2RuntimeDiagnostics({
      enabled: false,
      environment: "development",
      runtime,
      refreshMs: 250,
    }));
    const production = renderHook(() => useTerminalV2RuntimeDiagnostics({
      enabled: true,
      environment: "production",
      runtime,
      refreshMs: 250,
    }));

    act(() => vi.advanceTimersByTime(1_000));

    expect(disabled.result.current).toBeNull();
    expect(production.result.current).toBeNull();
    expect(runtime.getRuntimeDiagnosticsSnapshot).not.toHaveBeenCalled();
  });
});
