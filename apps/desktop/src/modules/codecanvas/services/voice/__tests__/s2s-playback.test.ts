import { beforeEach, describe, expect, it, vi } from "vitest";

// Reply audio is routed AudioContext → MediaStreamAudioDestinationNode → <audio srcObject>. Closing the
// context and pausing the element leaves the destination node's MediaStreamTracks in `live` state, so a
// media track outlives the voice session it belonged to.

const destTrack = vi.hoisted(() => ({ stop: vi.fn(), readyState: "live" }));
const ctxClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  resume() {
    return Promise.resolve();
  }
  createMediaStreamDestination() {
    return { stream: { getTracks: () => [destTrack] } };
  }
  createGain() {
    return {
      gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  }
  close() {
    return ctxClose();
  }
}

class FakeAudio {
  srcObject: unknown = null;
  autoplay = false;
  play() {
    return Promise.resolve();
  }
  pause() {}
}

beforeEach(() => {
  destTrack.stop.mockClear();
  ctxClose.mockClear();
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  (globalThis as unknown as { Audio: unknown }).Audio = FakeAudio;
});

describe("createS2sPlayback — dispose", () => {
  it("stops the output stream's tracks so no media track outlives the session", async () => {
    const { createS2sPlayback } = await import("../s2s-playback");
    const playback = createS2sPlayback(24000);

    playback.dispose();

    expect(destTrack.stop).toHaveBeenCalled();
    expect(ctxClose).toHaveBeenCalled();
  });

  it("is idempotent — a second dispose does not re-stop the tracks", async () => {
    const { createS2sPlayback } = await import("../s2s-playback");
    const playback = createS2sPlayback(24000);

    playback.dispose();
    playback.dispose();

    expect(destTrack.stop).toHaveBeenCalledTimes(1);
  });
});
