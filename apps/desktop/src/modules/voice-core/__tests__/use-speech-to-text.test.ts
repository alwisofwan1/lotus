// Lifecycle hardening for the push-to-talk hook: a mid-stream provider error or an unmount
// must RELEASE THE MIC (provider.cancel()), not just flip the recording flag — the streaming
// provider tears down its MediaStream/AudioContext only in stop()/cancel(), so skipping the
// cancel left the mic indicator lit until the next start().

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SttProvider } from "../stt-provider";
import type { SttDecoderContext } from "@/lib/tauri-api";

const resolveSttProvider = vi.fn();
const { sttTranscribe } = vi.hoisted(() => ({
  sttTranscribe: vi.fn(async () => ({ text: "", detectedLanguages: [] as string[] })),
}));
vi.mock("../resolve-stt-provider", () => ({
  resolveSttProvider: (...args: unknown[]) => resolveSttProvider(...args),
}));
const registryState = vi.hoisted(() => ({ registry: { activeProvider: "deepgram", providers: [] as unknown[] } }));
vi.mock("@/lib/hooks/useSttProviderRegistry", () => ({
  useSttProviderRegistry: () => ({ registry: registryState.registry }),
}));
vi.mock("@/lib/tauri-api", () => ({
  sttTranscribe: sttTranscribe,
  isTauri: () => true,
}));

import { useSpeechToText } from "../use-speech-to-text";

function fakeProvider() {
  return {
    id: "fake",
    kind: "custom",
    isAvailable: () => true,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => "transcript"),
    cancel: vi.fn(),
  } satisfies SttProvider;
}

describe("useSpeechToText — mic lifecycle", () => {
  let provider: ReturnType<typeof fakeProvider>;
  let capturedOnError: ((msg: string) => void) | null;
  let capturedOnSpectrum: ((bands: number[]) => void) | null;
  let capturedCloudDepsFor: ((id: string) => { transcribe: (b64: string, mime: string) => Promise<string> }) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = fakeProvider();
    registryState.registry = { activeProvider: "deepgram", providers: [] };
    capturedOnError = null;
    capturedOnSpectrum = null;
    capturedCloudDepsFor = null;
    resolveSttProvider.mockImplementation((_active, _providers, opts) => {
      capturedOnError = (opts as { onError: (msg: string) => void }).onError;
      capturedOnSpectrum = (opts as { onSpectrum?: (bands: number[]) => void }).onSpectrum ?? null;
      capturedCloudDepsFor = (opts as { cloudDepsFor: typeof capturedCloudDepsFor }).cloudDepsFor;
      return provider;
    });
  });

  it("forwards the provider's spectrum frames to the hook's onSpectrum option", async () => {
    const onSpectrum = vi.fn();
    renderHook(() => useSpeechToText({ onSpectrum }));
    expect(capturedOnSpectrum).toBeTypeOf("function");
    act(() => capturedOnSpectrum?.([0.1, 0.9]));
    expect(onSpectrum).toHaveBeenCalledWith([0.1, 0.9]);
  });

  it("snapshots structured decoder context at capture start", async () => {
    const { result } = renderHook(() => useSpeechToText());
    const context: SttDecoderContext = {
      prompt: "Canvas command",
      keywords: ["Lotus", "AGENTS.md"],
      languages: ["id", "en"],
    };

    await act(async () => {
      await result.current.start(context);
    });
    context.keywords.push("late canvas change");
    await capturedCloudDepsFor?.("openai").transcribe("QQ==", "audio/webm");

    expect(sttTranscribe).toHaveBeenCalledWith("openai", "QQ==", "audio/webm", {
      prompt: "Canvas command",
      keywords: ["Lotus", "AGENTS.md"],
      languages: ["id", "en"],
    });
  });

  it("reports captured provider metadata even when streaming/browser providers bypass batch transcription", async () => {
    registryState.registry = {
      activeProvider: "deepgram",
      providers: [{ id: "deepgram", model: "nova-3" }],
    };
    const { result } = renderHook(() => useSpeechToText());

    await act(async () => {
      await result.current.start({ prompt: "Natural speech", keywords: [], languages: ["id", "en"] });
      await result.current.stop();
    });

    expect(result.current.getLastTurnMetadata()).toEqual({
      provider: "deepgram",
      model: "nova-3",
      requestedLanguages: ["id", "en"],
      detectedLanguages: [],
    });
  });

  it("exposes pending mic startup so Escape and Live Voice can cancel it", async () => {
    const starting = (() => {
      let resolve!: () => void;
      return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
    })();
    provider.start.mockReturnValueOnce(starting.promise);
    const { result } = renderHook(() => useSpeechToText());

    act(() => {
      void result.current.start();
    });
    expect(result.current.starting).toBe(true);

    act(() => result.current.cancel());
    expect(result.current.starting).toBe(false);
    starting.resolve();
  });

  it("does not resurrect recording when cancel wins a pending start race", async () => {
    const starting = (() => {
      let resolve!: () => void;
      return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
    })();
    provider.start.mockReturnValueOnce(starting.promise);
    const { result } = renderHook(() => useSpeechToText());

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.start();
    });
    act(() => result.current.cancel());
    let started = true;
    await act(async () => {
      starting.resolve();
      started = await pending;
    });

    expect(started).toBe(false);
    expect(provider.cancel).toHaveBeenCalled();
    expect(result.current.recording).toBe(false);
  });

  it("does not let a cancelled stop completion clear a newer capture owned by the same provider", async () => {
    let resolveOldStop!: (text: string) => void;
    provider.stop
      .mockReturnValueOnce(new Promise<string>((resolve) => { resolveOldStop = resolve; }))
      .mockResolvedValueOnce("new transcript");
    const { result } = renderHook(() => useSpeechToText());

    await act(async () => {
      await result.current.start({ prompt: "old", keywords: [], languages: ["id"] });
    });
    let oldStop!: Promise<string>;
    act(() => {
      oldStop = result.current.stop();
    });
    act(() => result.current.cancel());
    await act(async () => {
      await result.current.start({ prompt: "new", keywords: [], languages: ["en"] });
    });
    await act(async () => {
      resolveOldStop("stale transcript");
      await oldStop;
    });

    let newTranscript = "";
    await act(async () => {
      newTranscript = await result.current.stop();
    });
    expect(newTranscript).toBe("new transcript");
    expect(provider.stop).toHaveBeenCalledTimes(2);
  });

  it("does not cancel a newer capture when an old cancelled stop rejects late", async () => {
    let rejectOldStop!: (error: Error) => void;
    provider.stop
      .mockReturnValueOnce(new Promise<string>((_resolve, reject) => { rejectOldStop = reject; }))
      .mockResolvedValueOnce("new transcript");
    const { result } = renderHook(() => useSpeechToText());

    await act(async () => { await result.current.start(); });
    let oldStop!: Promise<string>;
    act(() => { oldStop = result.current.stop(); });
    act(() => result.current.cancel());
    await act(async () => { await result.current.start(); });
    await act(async () => {
      rejectOldStop(new Error("stale stop failed"));
      await oldStop.catch(() => undefined);
    });

    expect(provider.cancel).toHaveBeenCalledTimes(1);
    await act(async () => {
      await expect(result.current.stop()).resolves.toBe("new transcript");
    });
  });

  it("stops the provider that owns the active capture even if settings resolve a new provider", async () => {
    const providerA = provider;
    const providerB = fakeProvider();
    let selected = providerA;
    resolveSttProvider.mockImplementation((_active, _providers, opts) => {
      capturedOnError = (opts as { onError: (msg: string) => void }).onError;
      capturedOnSpectrum = (opts as { onSpectrum?: (bands: number[]) => void }).onSpectrum ?? null;
      capturedCloudDepsFor = (opts as { cloudDepsFor: typeof capturedCloudDepsFor }).cloudDepsFor;
      return selected;
    });
    const { result, rerender } = renderHook(() => useSpeechToText());
    await act(async () => {
      await result.current.start();
    });

    selected = providerB;
    registryState.registry = { activeProvider: "openai", providers: [] };
    rerender();
    await act(async () => {
      await result.current.stop();
    });

    expect(providerA.stop).toHaveBeenCalledOnce();
    expect(providerB.stop).not.toHaveBeenCalled();
  });

  it("ignores a late error from a replaced provider instead of cancelling the new capture", async () => {
    const providerA = provider;
    const callbacks: Array<(message: string) => void> = [];
    const providerB = fakeProvider();
    let selected = providerA;
    resolveSttProvider.mockImplementation((_active, _providers, opts) => {
      callbacks.push((opts as { onError: (message: string) => void }).onError);
      return selected;
    });
    const { result, rerender } = renderHook(() => useSpeechToText());
    await act(async () => {
      await result.current.start();
    });
    act(() => result.current.cancel());

    selected = providerB;
    registryState.registry = { activeProvider: "openai", providers: [] };
    rerender();
    await act(async () => {
      await result.current.start();
    });
    act(() => callbacks[0]?.("late old-session error"));

    expect(providerB.cancel).not.toHaveBeenCalled();
    expect(result.current.recording).toBe(true);
  });

  it("releases the mic (provider.cancel) when the provider errors mid-recording", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useSpeechToText({ onError }));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.recording).toBe(true);

    act(() => {
      capturedOnError?.("recognition error");
    });

    expect(result.current.recording).toBe(false);
    expect(provider.cancel).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("recognition error");
  });

  it("does not touch the provider on an error while idle (no capture to release)", () => {
    renderHook(() => useSpeechToText());
    act(() => {
      capturedOnError?.("startup probe failed");
    });
    expect(provider.cancel).not.toHaveBeenCalled();
  });

  it("cancels an in-flight recording when the component unmounts", async () => {
    const { result, unmount } = renderHook(() => useSpeechToText());
    await act(async () => {
      await result.current.start();
    });

    unmount();

    expect(provider.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel on unmount when nothing was recording", () => {
    const { unmount } = renderHook(() => useSpeechToText());
    unmount();
    expect(provider.cancel).not.toHaveBeenCalled();
  });

  // A rejecting stop() is the one path with no owner left: `recordingRef` has already been cleared, so
  // the unmount guard is a no-op and the UI is back to idle — nothing would ever release the device.
  it("releases the mic when the provider's stop() rejects", async () => {
    const { result } = renderHook(() => useSpeechToText());
    await act(async () => {
      await result.current.start();
    });
    provider.stop.mockRejectedValueOnce(new Error("transcription round-trip failed"));

    let caught: unknown;
    await act(async () => {
      await result.current.stop().catch((err) => {
        caught = err;
      });
    });

    expect(caught).toBeInstanceOf(Error); // the caller still learns it failed
    expect(provider.cancel).toHaveBeenCalledTimes(1); // ...and the mic is free
    expect(result.current.transcribing).toBe(false);
  });
});
