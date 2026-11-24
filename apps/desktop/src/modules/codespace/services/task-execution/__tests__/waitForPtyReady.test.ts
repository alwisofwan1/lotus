import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitForPtyReady, type PtyReadyResult } from "../waitForPtyReady";
import type { PtyOutputMetrics } from "@/lib/tauri-api";

function metrics(opts: Partial<PtyOutputMetrics> = {}): PtyOutputMetrics {
  return {
    totalBytes: 0,
    bufferLen: 0,
    idleMs: 0,
    ageMs: 0,
    hasOutput: false,
    detectedAgent: null,
    ...opts,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForPtyReady", () => {
  it("resolves with reason='agent' once detectedAgent is non-null", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(metrics({ hasOutput: true, idleMs: 50 }))
      .mockResolvedValueOnce(metrics({ hasOutput: true, idleMs: 80, detectedAgent: "claude" }));
    const p: Promise<PtyReadyResult> = waitForPtyReady("sess_a", get, { pollMs: 30, timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(80);
    const r = await p;
    expect(r.reason).toBe("agent");
    expect(r.agent).toBe("claude");
  });

  it("resolves with reason='shell' once output settled and no agent banner appears", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(metrics({ hasOutput: false, idleMs: 0 }))
      .mockResolvedValueOnce(metrics({ hasOutput: true, idleMs: 200 }))
      .mockResolvedValueOnce(metrics({ hasOutput: true, idleMs: 600 }));
    const p = waitForPtyReady("sess_b", get, { pollMs: 50, timeoutMs: 5_000, shellIdleMs: 400 });
    await vi.advanceTimersByTimeAsync(180);
    const r = await p;
    expect(r.reason).toBe("shell");
  });

  it("resolves with reason='timeout' if neither agent nor settled output appears in time", async () => {
    const get = vi.fn().mockResolvedValue(metrics({ hasOutput: true, idleMs: 50 }));
    const p = waitForPtyReady("sess_c", get, { pollMs: 50, timeoutMs: 200, shellIdleMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    const r = await p;
    expect(r.reason).toBe("timeout");
  });

  it("resolves with reason='gone' if metrics returns null (session vanished)", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const p = waitForPtyReady("sess_d", get, { pollMs: 30, timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(50);
    const r = await p;
    expect(r.reason).toBe("gone");
  });

  it("respects an aborted signal and resolves with reason='aborted'", async () => {
    const ac = new AbortController();
    const get = vi.fn().mockResolvedValue(metrics({ hasOutput: false }));
    const p = waitForPtyReady("sess_e", get, { pollMs: 30, timeoutMs: 5_000, signal: ac.signal });
    ac.abort();
    await vi.advanceTimersByTimeAsync(50);
    const r = await p;
    expect(r.reason).toBe("aborted");
  });
});
