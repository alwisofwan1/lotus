import { describe, expect, it, vi } from "vitest";
import { stopScheduledAudioSource } from "../audio-stop-envelope";

function fakeScheduledAudio(now = 1, startAt = 2) {
  const gain = {
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
  };
  const source = { stop: vi.fn() };
  return { gain, source, now, startAt };
}

describe("stopScheduledAudioSource", () => {
  it("silences future scheduled chunks before stopping them", () => {
    const f = fakeScheduledAudio(1, 2);

    stopScheduledAudioSource({
      now: f.now,
      startAt: f.startAt,
      gain: f.gain,
      source: f.source,
      mode: "fade",
      releaseSeconds: 0.018,
    });

    expect(f.gain.cancelScheduledValues).toHaveBeenCalledWith(1);
    expect(f.gain.setValueAtTime).toHaveBeenCalledWith(0, 1);
    expect(f.gain.setTargetAtTime).not.toHaveBeenCalled();
    expect(f.source.stop).toHaveBeenCalledWith(1);
  });

  it("fades currently audible chunks instead of hard-cutting them", () => {
    const f = fakeScheduledAudio(3, 2);

    stopScheduledAudioSource({
      now: f.now,
      startAt: f.startAt,
      gain: f.gain,
      source: f.source,
      mode: "fade",
      releaseSeconds: 0.018,
    });

    expect(f.gain.cancelScheduledValues).toHaveBeenCalledWith(3);
    expect(f.gain.setTargetAtTime).toHaveBeenCalledWith(0, 3, expect.closeTo(0.006, 6));
    expect(f.source.stop).toHaveBeenCalledWith(3.018);
  });

  it("hard-silences immediate stops", () => {
    const f = fakeScheduledAudio(3, 2);

    stopScheduledAudioSource({
      now: f.now,
      startAt: f.startAt,
      gain: f.gain,
      source: f.source,
      mode: "immediate",
      releaseSeconds: 0.018,
    });

    expect(f.gain.setValueAtTime).toHaveBeenCalledWith(0, 3);
    expect(f.gain.setTargetAtTime).not.toHaveBeenCalled();
    expect(f.source.stop).toHaveBeenCalledWith(3);
  });
});
