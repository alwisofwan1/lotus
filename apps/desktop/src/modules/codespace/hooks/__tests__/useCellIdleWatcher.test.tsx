import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCellIdleWatcher } from "../useCellIdleWatcher";
import type { PtyOutputMetrics } from "@/lib/tauri-api";

describe("useCellIdleWatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not treat unchanged startup output as completed work", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const metrics: PtyOutputMetrics = {
      totalBytes: 1_200,
      idleMs: 0,
      detectedAgent: "codex",
      bufferLen: 1_200,
      ageMs: 0,
      hasOutput: true,
    };
    const getMetrics = vi.fn(async () => metrics);

    renderHook(() =>
      useCellIdleWatcher({
        cells: [{ paneId: "pane-codex", sessionId: "session-codex" }],
        getMetrics,
        onIdle,
        idleThresholdMs: 8_000,
        pollIntervalMs: 1_000,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    metrics.idleMs = 9_000;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });

    expect(onIdle).not.toHaveBeenCalled();
  });

  it("fires after new output appears and then settles", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const metrics: PtyOutputMetrics = {
      totalBytes: 0,
      idleMs: 0,
      detectedAgent: "codex",
      bufferLen: 0,
      ageMs: 0,
      hasOutput: false,
    };
    const getMetrics = vi.fn(async () => metrics);

    renderHook(() =>
      useCellIdleWatcher({
        cells: [{ paneId: "pane-codex", sessionId: "session-codex", runId: 1 }],
        getMetrics,
        onIdle,
        idleThresholdMs: 8_000,
        pollIntervalMs: 1_000,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    metrics.totalBytes = 1_200;
    metrics.idleMs = 0;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    metrics.idleMs = 9_000;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledWith("pane-codex", "session-codex");
  });

  /** Drive one busy→idle turn: burst of output, then settle past the idle threshold. */
  async function runTurn(metrics: PtyOutputMetrics, addBytes: number) {
    metrics.totalBytes += addBytes;
    metrics.idleMs = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    metrics.idleMs = 9_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
  }

  it("by default fires only once per session even across multiple turns", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const metrics: PtyOutputMetrics = { totalBytes: 0, idleMs: 0, detectedAgent: "codex", bufferLen: 0, ageMs: 0, hasOutput: false };
    renderHook(() =>
      useCellIdleWatcher({
        cells: [{ paneId: "p", sessionId: "s" }],
        getMetrics: vi.fn(async () => metrics),
        onIdle,
        idleThresholdMs: 8_000,
        pollIntervalMs: 1_000,
      }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); // arm baseline
    await runTurn(metrics, 1_200);
    await runTurn(metrics, 1_200);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("with reArmOnActivity, fires once per turn on a persistent session", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const metrics: PtyOutputMetrics = { totalBytes: 0, idleMs: 0, detectedAgent: "codex", bufferLen: 0, ageMs: 0, hasOutput: false };
    renderHook(() =>
      useCellIdleWatcher({
        cells: [{ paneId: "p", sessionId: "s" }],
        getMetrics: vi.fn(async () => metrics),
        onIdle,
        idleThresholdMs: 8_000,
        pollIntervalMs: 1_000,
        reArmOnActivity: true,
      }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); // arm baseline
    await runTurn(metrics, 1_200); // turn 1 → fire
    await runTurn(metrics, 1_200); // fresh burst → re-arm → fire again
    await runTurn(metrics, 1_200); // and again
    expect(onIdle).toHaveBeenCalledTimes(3);
  });
});
