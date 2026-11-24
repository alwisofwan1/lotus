import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The batch (MediaRecorder) capture path owns a live mic stream. Releasing it ONLY from `onstop` means
// any path that skips that event — a recorder already `inactive` so `stop()` throws, or a WKWebView
// recorder that never reports — leaves the microphone held with nothing left to release it. On macOS a
// held mic also keeps the shared audio device in voice-processing mode, so a concurrent call stays
// muffled long after the UI says recording ended.

const track = vi.hoisted(() => ({ stop: vi.fn() }));
const gum = vi.hoisted(() => ({ constraints: undefined as unknown }));
const recorder = vi.hoisted(() => ({
  instance: undefined as undefined | FakeMediaRecorderShape,
  stopThrows: undefined as undefined | Error,
  fireOnStop: true,
}));

interface FakeMediaRecorderShape {
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start: () => void;
  stop: () => void;
}

beforeEach(() => {
  vi.useFakeTimers();
  track.stop.mockClear();
  gum.constraints = undefined;
  recorder.stopThrows = undefined;
  recorder.fireOnStop = true;

  (globalThis as unknown as { navigator: unknown }).navigator = {
    mediaDevices: {
      getUserMedia: (constraints: unknown) => {
        gum.constraints = constraints;
        return Promise.resolve({ getTracks: () => [track] });
      },
    },
  };

  class FakeMediaRecorder implements FakeMediaRecorderShape {
    mimeType = "audio/webm";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      recorder.instance = this;
    }
    stop() {
      if (recorder.stopThrows) throw recorder.stopThrows;
      if (recorder.fireOnStop) this.onstop?.();
    }
  }
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("createCloudSttProvider — batch mic release", () => {
  it("captures without voice processing so a concurrent call on the same device stays clean", async () => {
    const { createCloudSttProvider } = await import("../cloud-stt-provider");
    const provider = createCloudSttProvider("openai", "openai", { transcribe: async () => "" });

    await provider.start();

    expect(gum.constraints).toEqual({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    provider.cancel();
  });

  it("releases the mic when MediaRecorder.stop() throws because the recorder already went inactive", async () => {
    const { createCloudSttProvider } = await import("../cloud-stt-provider");
    const transcribe = vi.fn(async () => "should not be called");
    const provider = createCloudSttProvider("openai", "openai", { transcribe });
    await provider.start();
    recorder.stopThrows = Object.assign(new Error("The MediaRecorder is inactive"), {
      name: "InvalidStateError",
    });

    await expect(provider.stop()).resolves.toBe("");

    expect(track.stop).toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled(); // nothing was captured — no round-trip to burn
  });

  it("releases the mic when the recorder accepts stop() but never reports that it stopped", async () => {
    const { createCloudSttProvider } = await import("../cloud-stt-provider");
    const provider = createCloudSttProvider("openai", "openai", { transcribe: async () => "" });
    await provider.start();
    recorder.fireOnStop = false; // the WKWebView recorder that silently swallows the event

    const stopped = provider.stop();
    expect(track.stop).not.toHaveBeenCalled(); // nothing has reported yet — still legitimately held

    await vi.advanceTimersByTimeAsync(2_000);

    await expect(stopped).resolves.toBe("");
    expect(track.stop).toHaveBeenCalled(); // the watchdog freed it instead of hanging forever
  });
});
