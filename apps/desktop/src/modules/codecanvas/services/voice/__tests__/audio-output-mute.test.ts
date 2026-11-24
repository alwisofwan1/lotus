import { describe, expect, it, vi } from "vitest";
import { setAudioOutputMuted } from "../audio-output-mute";

describe("setAudioOutputMuted", () => {
  it("ramps master output to silence", () => {
    const gain = {
      cancelScheduledValues: vi.fn(),
      setTargetAtTime: vi.fn(),
    };

    setAudioOutputMuted({ gain, now: 2, muted: true });

    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(2);
    expect(gain.setTargetAtTime).toHaveBeenCalledWith(0, 2, expect.closeTo(0.01, 6));
  });

  it("ramps master output back to full volume", () => {
    const gain = {
      cancelScheduledValues: vi.fn(),
      setTargetAtTime: vi.fn(),
    };

    setAudioOutputMuted({ gain, now: 3, muted: false });

    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(3);
    expect(gain.setTargetAtTime).toHaveBeenCalledWith(1, 3, expect.closeTo(0.012, 6));
  });
});
