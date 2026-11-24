import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createS2sTranscriptWaitQueue,
  S2S_TRANSCRIPT_INITIAL_WAIT_MS,
  S2S_TRANSCRIPT_MAX_WAIT_MS,
} from "../s2s-transcript-wait-queue";

describe("S2S transcript wait queue", () => {
  afterEach(() => vi.useRealTimers());

  it("falls back at the shorter initial deadline when transcription never starts", async () => {
    vi.useFakeTimers();
    const queue = createS2sTranscriptWaitQueue();
    const result = queue.wait();

    await vi.advanceTimersByTimeAsync(S2S_TRANSCRIPT_INITIAL_WAIT_MS - 1);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeNull();
  });

  it("extends an active transcription without exceeding the hard cap", async () => {
    vi.useFakeTimers();
    const queue = createS2sTranscriptWaitQueue();
    const result = queue.wait();

    await vi.advanceTimersByTimeAsync(S2S_TRANSCRIPT_INITIAL_WAIT_MS - 100);
    queue.noteProgress();
    await vi.advanceTimersByTimeAsync(150);

    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(S2S_TRANSCRIPT_MAX_WAIT_MS);
    await expect(result).resolves.toBeNull();
  });

  it("resolves all pending waits immediately when final text arrives", async () => {
    vi.useFakeTimers();
    const queue = createS2sTranscriptWaitQueue();
    const first = queue.wait();
    const second = queue.wait();

    queue.resolveFinal("Kirim ke Atlas.");

    await expect(first).resolves.toBe("Kirim ke Atlas.");
    await expect(second).resolves.toBe("Kirim ke Atlas.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reset cancels pending waits and timers", async () => {
    vi.useFakeTimers();
    const queue = createS2sTranscriptWaitQueue();
    const result = queue.wait();

    queue.reset();

    await expect(result).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
