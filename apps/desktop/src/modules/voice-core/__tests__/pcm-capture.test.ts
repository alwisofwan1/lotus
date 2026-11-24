import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A partial-init failure (mic denied mid-setup, worklet load failure in WKWebView) must release every
// resource acquired so far — the caller never receives a stop() handle to do it itself (P0-4).

const track = vi.hoisted(() => ({ stop: vi.fn() }));
const ctxClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const gum = vi.hoisted(() => ({
  impl: undefined as undefined | (() => Promise<unknown>),
  constraints: undefined as unknown,
}));
const addModule = vi.hoisted(() => ({
  impl: undefined as undefined | (() => Promise<void>),
  urls: [] as string[],
}));

class FakeAudioContext {
  state = "running";
  destination = {};
  resume() {
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createGain() {
    return { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  audioWorklet = {
    addModule: (url: string) => {
      addModule.urls.push(url);
      return (addModule.impl ?? (() => Promise.resolve()))();
    },
  };
  close() {
    return ctxClose();
  }
}

class FakeAudioWorkletNode {
  port: { onmessage: unknown } = { onmessage: null };
  connect = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  track.stop.mockClear();
  ctxClose.mockClear();
  gum.impl = undefined;
  gum.constraints = undefined;
  addModule.impl = undefined;
  addModule.urls = [];
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeAudioWorkletNode;
  (globalThis as unknown as { navigator: unknown }).navigator = {
    mediaDevices: {
      getUserMedia: (constraints: unknown) => {
        gum.constraints = constraints;
        return (gum.impl ?? (() => Promise.resolve({ getTracks: () => [track] })))();
      },
    },
  };
});
afterEach(() => vi.clearAllMocks());

// The production CSP's script-src has no `blob:`, and WebKit checks a worklet module against
// script-src — a Blob URL failed every release capture with "Not allowed by CSP".
describe("createPcmCapture — worklet module origin", () => {
  it("loads the worklet from the app's own origin, never from a Blob URL", async () => {
    const { createPcmCapture } = await import("../pcm-capture");

    const capture = await createPcmCapture({ targetRate: 24000, onChunk: () => {} });

    expect(addModule.urls).toEqual(["/voice/pcm-capture-worklet.js"]);
    capture.stop();
  });
});

// macOS engages the CoreAudio Voice-Processing I/O unit when a capture asks for echo cancellation.
// VPIO takes over the built-in input/output PAIR, so it degrades every OTHER app sharing that device
// (a Google Meet call goes muffled). Only the duplex S2S path needs it; push-to-talk STT must not pay
// that system-wide cost.
describe("createPcmCapture — voice-processing constraints", () => {
  it("asks for a raw mic by default so the system audio device stays untouched", async () => {
    const { createPcmCapture } = await import("../pcm-capture");

    const capture = await createPcmCapture({ targetRate: 16000, onChunk: () => {} });

    expect(gum.constraints).toEqual({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    capture.stop();
  });

  it("asks for voice processing only when the duplex caller opts in", async () => {
    const { createPcmCapture } = await import("../pcm-capture");

    const capture = await createPcmCapture({
      targetRate: 24000,
      onChunk: () => {},
      voiceProcessing: true,
    });

    expect(gum.constraints).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    capture.stop();
  });
});

// "The UI says stopped" must be able to mean "the device is gone". That needs an awaitable release:
// ending the tracks is synchronous, but the AudioContext close is not, and until it settles the
// process still holds an audio unit on the device.
describe("createPcmCapture — awaitable release", () => {
  it("ends the mic tracks immediately but resolves stop() only once the context has closed", async () => {
    const { createPcmCapture } = await import("../pcm-capture");
    let finishClose: (() => void) | undefined;
    ctxClose.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          finishClose = () => res();
        }),
    );
    const capture = await createPcmCapture({ targetRate: 16000, onChunk: () => {} });

    let released = false;
    const stopping = capture.stop().then(() => {
      released = true;
    });
    await Promise.resolve();

    expect(track.stop).toHaveBeenCalled(); // mic freed at once — never gated behind the close
    expect(released).toBe(false); // ...but release is not yet complete

    finishClose?.();
    await stopping;
    expect(released).toBe(true);
  });
});

describe("createPcmCapture — partial-init cleanup (P0-4)", () => {
  it("closes the AudioContext when getUserMedia rejects (mic denied)", async () => {
    const { createPcmCapture } = await import("../pcm-capture");
    gum.impl = () => Promise.reject(new Error("NotAllowedError"));

    await expect(createPcmCapture({ targetRate: 16000, onChunk: () => {} })).rejects.toThrow();
    expect(ctxClose).toHaveBeenCalled(); // context released even though we never got a stop() handle
  });

  it("stops the mic stream AND closes the context when the worklet fails to load", async () => {
    const { createPcmCapture } = await import("../pcm-capture");
    // getUserMedia succeeds, but addModule throws afterwards — the classic WKWebView failure.
    addModule.impl = () => Promise.reject(new Error("addModule failed"));

    await expect(createPcmCapture({ targetRate: 24000, onChunk: () => {} })).rejects.toThrow();
    expect(track.stop).toHaveBeenCalled(); // the live mic stream was released
    expect(ctxClose).toHaveBeenCalled();
  });
});
