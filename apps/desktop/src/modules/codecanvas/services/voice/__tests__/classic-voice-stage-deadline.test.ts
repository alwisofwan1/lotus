import { describe, expect, it, vi } from "vitest";
import { waitForClassicVoiceStage } from "../classic-voice-stage-deadline";

describe("waitForClassicVoiceStage", () => {
  it("rejects a stage that exceeds its bounded deadline", async () => {
    vi.useFakeTimers();
    try {
      const waiting = waitForClassicVoiceStage(new Promise<string>(() => {}), {
        stage: "STT finalization",
        timeoutMs: 100,
      });
      const assertion = expect(waiting).rejects.toThrow("STT finalization timed out");

      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately when the owning turn is aborted", async () => {
    const aborter = new AbortController();
    const waiting = waitForClassicVoiceStage(new Promise<string>(() => {}), {
      stage: "delivery receipt",
      timeoutMs: 5_000,
      signal: aborter.signal,
    });

    aborter.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
