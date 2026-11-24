import { describe, it, expect, vi } from "vitest";
import { createCloudSttProvider, type SttRecording } from "../cloud-stt-provider";

/**
 * The batch (MediaRecorder) provider must also feed the listening-border spectrum: batch is what the
 * fallback wrapper lands on when Deepgram streaming can't connect, and what OpenAI/custom BYOK use —
 * without this tap the border sits on its static drift for every non-streaming capture.
 */
function harness(overrides: { stream?: MediaStream | undefined } = {}) {
  const stopTap = vi.fn();
  const spectrumTap = vi.fn(() => ({ stop: stopTap }));
  const onSpectrum = vi.fn();
  const recording: SttRecording = {
    stop: vi.fn(async () => ({ base64: "QQ==", mime: "audio/webm" })),
    cancel: vi.fn(),
    stream: "stream" in overrides ? overrides.stream : ({} as MediaStream),
  };
  const provider = createCloudSttProvider(
    "openai",
    "openai",
    { transcribe: vi.fn(async () => "hi"), record: vi.fn(async () => recording) },
    { onSpectrum, spectrumTap },
  );
  return { provider, spectrumTap, stopTap, onSpectrum, recording };
}

describe("cloud STT provider — spectrum tap", () => {
  it("taps the recording's stream on start and releases the tap on stop", async () => {
    const { provider, spectrumTap, stopTap, onSpectrum, recording } = harness();
    await provider.start();
    expect(spectrumTap).toHaveBeenCalledWith(recording.stream, onSpectrum);
    await provider.stop();
    expect(stopTap).toHaveBeenCalled();
  });

  it("releases the tap on cancel", async () => {
    const { provider, stopTap } = harness();
    await provider.start();
    provider.cancel();
    expect(stopTap).toHaveBeenCalled();
  });

  it("skips the tap when the recorder exposes no stream (injected test recorders)", async () => {
    const { provider, spectrumTap } = harness({ stream: undefined });
    await provider.start();
    expect(spectrumTap).not.toHaveBeenCalled();
    await expect(provider.stop()).resolves.toBe("hi"); // capture unaffected
  });

  it("does not tap at all when no onSpectrum consumer is registered", async () => {
    const spectrumTap = vi.fn(() => ({ stop: vi.fn() }));
    const provider = createCloudSttProvider(
      "openai",
      "openai",
      {
        transcribe: vi.fn(async () => ""),
        record: vi.fn(async () => ({ stop: vi.fn(async () => ({ base64: "", mime: "" })), cancel: vi.fn(), stream: {} as MediaStream })),
      },
      { spectrumTap },
    );
    await provider.start();
    expect(spectrumTap).not.toHaveBeenCalled();
  });
});
