import { describe, expect, it, vi } from "vitest";
import { base64ToBlob, createCloudTtsProvider, playCloudTtsAudio } from "../cloud-tts-provider";

describe("base64ToBlob", () => {
  it("decodes base64 audio bytes into a Blob of the given MIME type", () => {
    const base64 = btoa("ID3fakeaudio"); // stand-in for MP3 bytes
    const blob = base64ToBlob(base64, "audio/mpeg");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBe("ID3fakeaudio".length);
  });

  it("round-trips the exact byte contents, including high bytes", async () => {
    const bytes = Uint8Array.from([0x49, 0x44, 0x33, 0x00, 0xff, 0x7f, 0x80]);
    const base64 = btoa(String.fromCharCode(...bytes));
    const blob = base64ToBlob(base64, "audio/wav");
    const roundTripped = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(roundTripped)).toEqual(Array.from(bytes));
  });
});

describe("createCloudTtsProvider", () => {
  it("synthesizes then plays through the injected player (no data-URI on the main thread)", async () => {
    const synthesize = vi.fn().mockResolvedValue({ audioBase64: btoa("clip"), mime: "audio/mpeg" });
    const play = vi.fn().mockResolvedValue(undefined);
    const provider = createCloudTtsProvider("openai-tts", "openai", { synthesize, play });

    await provider.speak("halo dunia", { language: "id" });

    expect(synthesize).toHaveBeenCalledWith("halo dunia", expect.objectContaining({ language: "id" }));
    expect(play).toHaveBeenCalledWith({ audioBase64: btoa("clip"), mime: "audio/mpeg" }, expect.anything());
  });

  it("skips empty text without synthesizing", async () => {
    const synthesize = vi.fn();
    const provider = createCloudTtsProvider("openai-tts", "openai", { synthesize, play: vi.fn() });
    await provider.speak("   ");
    expect(synthesize).not.toHaveBeenCalled();
  });

  // Barge-in parity with the browser provider (which s.cancel()s before every utterance): a second
  // speak MUST abort the first still-playing clip. Without this, cloud TTS overlaps back-to-back
  // callouts — the "agent finished" line is heard several times over (the duplicate-voice bug).
  it("barges in — a second speak aborts the first still-playing utterance", async () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const signals: AbortSignal[] = [];
    const synthesize = vi.fn().mockResolvedValue({ audioBase64: btoa("clip"), mime: "audio/mpeg" });
    // A play that never resolves stands in for audio still in flight, so barge-in is observable.
    const play = vi.fn((_result: unknown, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<void>(() => {});
    });
    const provider = createCloudTtsProvider("openai-tts", "openai", { synthesize, play });

    void provider.speak("Nova is done.");
    await flush();
    void provider.speak("Nova just finished.");
    await flush();

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true); // the first utterance was barged-in
    expect(signals[1].aborted).toBe(false); // the latest utterance is live
  });

  it("stop() aborts the in-flight utterance", async () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    let played: AbortSignal | undefined;
    const synthesize = vi.fn().mockResolvedValue({ audioBase64: btoa("clip"), mime: "audio/mpeg" });
    const play = vi.fn((_result: unknown, signal?: AbortSignal) => {
      played = signal;
      return new Promise<void>(() => {});
    });
    const provider = createCloudTtsProvider("openai-tts", "openai", { synthesize, play });

    void provider.speak("Nova is done.");
    await flush();
    provider.stop();

    expect(played?.aborted).toBe(true);
  });

  it("bounds replacement bursts to one active synthesis and one latest pending utterance", async () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    let finishFirst!: (result: { audioBase64: string; mime: string }) => void;
    const firstResult = new Promise<{ audioBase64: string; mime: string }>((resolve) => {
      finishFirst = resolve;
    });
    const result = { audioBase64: btoa("clip"), mime: "audio/mpeg" };
    const synthesize = vi.fn()
      .mockImplementationOnce(() => firstResult)
      .mockResolvedValue(result);
    const play = vi.fn().mockResolvedValue(undefined);
    const provider = createCloudTtsProvider("openai-tts", "openai", { synthesize, play });

    const first = provider.speak("first");
    await flush();
    const replaced = provider.speak("second");
    const latest = provider.speak("third");
    await flush();

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenNthCalledWith(1, "first", expect.anything());

    finishFirst(result);
    await Promise.all([first, replaced, latest]);

    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize).toHaveBeenNthCalledWith(2, "third", expect.anything());
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("drops an externally aborted pending utterance before synthesis starts", async () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    let finishFirst!: (result: { audioBase64: string; mime: string }) => void;
    const result = { audioBase64: btoa("clip"), mime: "audio/mpeg" };
    const synthesize = vi.fn()
      .mockImplementationOnce(
        () => new Promise<{ audioBase64: string; mime: string }>((resolve) => { finishFirst = resolve; }),
      )
      .mockResolvedValue(result);
    const provider = createCloudTtsProvider("openai-tts", "openai", {
      synthesize,
      play: vi.fn().mockResolvedValue(undefined),
    });
    const controller = new AbortController();

    const first = provider.speak("first");
    await flush();
    const pending = provider.speak("stale", { signal: controller.signal });
    controller.abort();
    finishFirst(result);
    await Promise.all([first, pending]);
    await flush();

    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("rejects and aborts playback when its lifecycle never settles", async () => {
    vi.useFakeTimers();
    const result = { audioBase64: btoa("clip"), mime: "audio/mpeg" };
    let playbackSignal: AbortSignal | undefined;
    const provider = createCloudTtsProvider("openai-tts", "openai", {
      synthesize: vi.fn().mockResolvedValue(result),
      play: vi.fn((_result, signal) => {
        playbackSignal = signal;
        return new Promise<void>(() => {});
      }),
      playbackWatchdogMs: 25,
    });

    const spoken = provider.speak("hello");
    const rejection = expect(spoken).rejects.toThrow("Cloud speech playback timed out.");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(playbackSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});

describe("playCloudTtsAudio", () => {
  it("does not create or play stale audio when aborted during source preparation", async () => {
    let finishSource!: () => void;
    const sourceReady = new Promise<void>((resolve) => { finishSource = resolve; });
    const play = vi.fn().mockResolvedValue(undefined);
    const AudioStub = vi.fn(function AudioStub(this: { play: typeof play }) {
      this.play = play;
    });
    vi.stubGlobal("Audio", AudioStub);
    vi.stubGlobal("fetch", vi.fn(async () => {
      await sourceReady;
      return { blob: async () => new Blob(["clip"], { type: "audio/mpeg" }) };
    }));
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:clip"),
      revokeObjectURL: vi.fn(),
    });
    const controller = new AbortController();

    const playback = playCloudTtsAudio(
      { audioBase64: btoa("clip"), mime: "audio/mpeg" },
      controller.signal,
    );
    controller.abort();
    finishSource();
    await playback;

    expect(AudioStub).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("unloads the element when playback ends, so no media session lingers", async () => {
    const element = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
      onended: null as null | (() => void),
      onerror: null as null | (() => void),
    };
    vi.stubGlobal("Audio", vi.fn(function AudioStub() { return element; }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob(["clip"], { type: "audio/mpeg" }) })));
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:clip"), revokeObjectURL: vi.fn() });

    const playback = playCloudTtsAudio({ audioBase64: btoa("clip"), mime: "audio/mpeg" });
    await vi.waitFor(() => expect(element.play).toHaveBeenCalled());
    element.onended?.();
    await playback;

    expect(element.removeAttribute).toHaveBeenCalledWith("src");
    expect(element.load).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
