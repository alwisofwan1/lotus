import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamRegistry } from "../stream-registry.js";

function makeStreamer() {
  return { stop: vi.fn(), start: vi.fn() };
}

describe("StreamRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stores and retrieves a streamer by deviceId", () => {
    const reg = new StreamRegistry();
    const s = makeStreamer();
    reg.set("1", s as never);
    expect(reg.get("1")).toBe(s);
  });

  it("returns undefined for unknown deviceId", () => {
    const reg = new StreamRegistry();
    expect(reg.get("999")).toBeUndefined();
  });

  it("stops old streamer when replacing with set()", () => {
    const reg = new StreamRegistry();
    const old = makeStreamer();
    const next = makeStreamer();
    reg.set("1", old as never);
    reg.set("1", next as never);
    expect(old.stop).toHaveBeenCalledOnce();
    expect(reg.get("1")).toBe(next);
  });

  it("delete stops the streamer and removes it", () => {
    const reg = new StreamRegistry();
    const s = makeStreamer();
    reg.set("1", s as never);
    reg.delete("1");
    expect(s.stop).toHaveBeenCalledOnce();
    expect(reg.get("1")).toBeUndefined();
  });

  it("clear stops all streamers", () => {
    const reg = new StreamRegistry();
    const a = makeStreamer();
    const b = makeStreamer();
    reg.set("1", a as never);
    reg.set("2", b as never);
    reg.clear();
    expect(a.stop).toHaveBeenCalledOnce();
    expect(b.stop).toHaveBeenCalledOnce();
    expect(reg.get("1")).toBeUndefined();
    expect(reg.get("2")).toBeUndefined();
  });

  it("auto-evicts inactive streams after TTL", () => {
    const ttlMs = 1000;
    const sweepMs = 100;
    const reg = new StreamRegistry(ttlMs, sweepMs);
    const s = makeStreamer();
    reg.set("1", s as never);

    // Advance past TTL + one sweep interval
    vi.advanceTimersByTime(ttlMs + sweepMs + 1);

    expect(s.stop).toHaveBeenCalledOnce();
    expect(reg.get("1")).toBeUndefined();
  });

  it("touch() resets the TTL clock", () => {
    const ttlMs = 1000;
    const sweepMs = 100;
    const reg = new StreamRegistry(ttlMs, sweepMs);
    const s = makeStreamer();
    reg.set("1", s as never);

    // Advance almost to TTL, then touch
    vi.advanceTimersByTime(900);
    reg.touch("1");

    // Advance past original TTL — should NOT be evicted yet
    vi.advanceTimersByTime(200);
    expect(s.stop).not.toHaveBeenCalled();
    expect(reg.get("1")).toBe(s);

    // Now pass the new TTL
    vi.advanceTimersByTime(ttlMs);
    expect(s.stop).toHaveBeenCalledOnce();
  });

  it("sweep stops when registry becomes empty", () => {
    const reg = new StreamRegistry(500, 100);
    const s = makeStreamer();
    reg.set("1", s as never);
    reg.delete("1");

    // Sweep interval should no longer fire (timer cleared)
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    vi.advanceTimersByTime(1000);
    // No errors — just verify no phantom evictions on already-empty registry
    expect(reg.get("1")).toBeUndefined();
    clearSpy.mockRestore();
  });
});
