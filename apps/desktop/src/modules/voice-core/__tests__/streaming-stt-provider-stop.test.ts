import { beforeEach, describe, expect, it, vi } from "vitest";

const createPcmCapture = vi.fn();
vi.mock("../pcm-capture", () => ({
  createPcmCapture: (...args: unknown[]) => createPcmCapture(...args),
}));

vi.mock("@/lib/tauri-api", () => ({
  sttStreamStart: vi.fn(),
  sttStreamSend: vi.fn(),
  sttStreamFinish: vi.fn(),
  sttStreamCancel: vi.fn(),
}));

import { createStreamingSttProvider } from "../streaming-stt-provider";
import type { SttStreamEvent } from "@/lib/tauri-api";

function nextTick(): Promise<void> {
  return Promise.resolve();
}

describe("createStreamingSttProvider — mic constraints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPcmCapture.mockResolvedValue({ stop: vi.fn() });
  });

  // Push-to-talk never plays agent audio while capturing (the speech gate stops TTS before start()),
  // so it must not engage macOS voice-processing mode and muffle a concurrent Meet call.
  it("captures without voice processing so a concurrent call on the same device stays clean", async () => {
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram",
      deps: {
        start: vi.fn(async () => "session-1"),
        send: vi.fn(async () => {}),
        finish: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
      },
    });

    await provider.start();

    expect(createPcmCapture).toHaveBeenCalledWith(
      expect.objectContaining({ voiceProcessing: false }),
    );
  });

  // The hook flips `transcribing` false when stop() resolves, and the command bar drops its voice
  // state with it. That claim is only honest if the device is already gone by then.
  it("resolves stop() only after the mic release has completed", async () => {
    const order: string[] = [];
    let finishRelease: (() => void) | undefined;
    createPcmCapture.mockResolvedValue({
      stop: vi.fn(
        () =>
          new Promise<void>((res) => {
            finishRelease = () => {
              order.push("released");
              res();
            };
          }),
      ),
    });
    // Held on an object so TS doesn't narrow the callback away (it can't see the assignment inside
    // the `start` double).
    const bus: { emit?: (event: SttStreamEvent) => void } = {};
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram",
      deps: {
        start: vi.fn(async (_id, cb) => {
          bus.emit = cb;
          return "session-1";
        }),
        send: vi.fn(async () => {}),
        finish: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
      },
    });
    await provider.start();
    bus.emit?.({ kind: "final", transcript: "arrange the canvas" });

    const stopping = provider.stop().then((text) => {
      order.push("stop-resolved");
      return text;
    });
    for (let i = 0; i < 10; i++) await nextTick();

    expect(order).toEqual([]); // transcript is ready, but stop() is still waiting on the device

    finishRelease?.();

    await expect(stopping).resolves.toBe("arrange the canvas");
    expect(order).toEqual(["released", "stop-resolved"]);
  });
});

describe("createStreamingSttProvider — stop finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPcmCapture.mockResolvedValue({ stop: vi.fn() });
  });

  it("does not let an old cancelled stop reset a newer streaming session", async () => {
    vi.useFakeTimers();
    try {
      const oldFinish = (() => {
        let resolve!: () => void;
        return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
      })();
      const callbacks: Array<(event: SttStreamEvent) => void> = [];
      let starts = 0;
      const finish = vi.fn((sessionId: string) => sessionId === "session-1" ? oldFinish.promise : Promise.resolve());
      createPcmCapture
        .mockResolvedValueOnce({ stop: vi.fn() })
        .mockResolvedValueOnce({ stop: vi.fn() });
      const provider = createStreamingSttProvider("deepgram", { kind: "deepgram",
        deps: {
          start: vi.fn(async (_id, callback) => {
            callbacks.push(callback);
            starts += 1;
            return `session-${starts}`;
          }),
          send: vi.fn(async () => {}),
          finish,
          cancel: vi.fn(async () => {}),
        },
      });

      await provider.start();
      const oldStop = provider.stop();
      provider.cancel();
      await provider.start();
      oldFinish.resolve();
      await vi.advanceTimersByTimeAsync(1_500);
      await oldStop;

      callbacks[1]?.({ kind: "final", transcript: "new transcript" });
      const newStop = provider.stop();
      await nextTick();
      callbacks[1]?.({ kind: "final", transcript: "new transcript" });
      await newStop;

      expect(finish).toHaveBeenCalledWith("session-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits briefly for a corrected final instead of executing the latest partial hypothesis", async () => {
    let onEvent: ((event: SttStreamEvent) => void) | null = null;
    const finish = vi.fn(async () => {});
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram",
      deps: {
        start: vi.fn(async (_id, cb) => {
          onEvent = cb;
          return "session-1";
        }),
        send: vi.fn(async () => {}),
        finish,
        cancel: vi.fn(async () => {}),
      },
    });

    await provider.start();
    const emit = onEvent as ((event: SttStreamEvent) => void) | null;
    emit?.({ kind: "partial", transcript: "arrange the can bus" });

    const stopResult = provider.stop();
    const pending = await Promise.race([
      stopResult,
      new Promise((r) => setTimeout(() => r("still-waiting"), 20)),
    ]);
    expect(pending).toBe("still-waiting");

    emit?.({ kind: "final", transcript: "arrange the canvas" });

    expect(finish).toHaveBeenCalledWith("session-1");
    const corrected = await Promise.race([
      stopResult,
      new Promise((r) => setTimeout(() => r("still-waiting"), 50)),
    ]);
    expect(corrected).toBe("arrange the canvas");
  });

  it("does not mistake a final emitted before Stop for the post-finish flush", async () => {
    let onEvent: ((event: SttStreamEvent) => void) | null = null;
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram",
      deps: {
        start: vi.fn(async (_id, cb) => {
          onEvent = cb;
          return "session-pre-final";
        }),
        send: vi.fn(async () => {}),
        finish: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
      },
    });

    await provider.start();
    const emit = onEvent as ((event: SttStreamEvent) => void) | null;
    emit?.({ kind: "final", transcript: "open terminal" });
    const stopping = provider.stop();
    const pending = await Promise.race([
      stopping,
      new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 20)),
    ]);
    expect(pending).toBe("still-waiting");

    emit?.({ kind: "final", transcript: "and run tests" });
    await expect(stopping).resolves.toBe("open terminal and run tests");
  });

  it("flushes every queued audio chunk before asking the provider to finish", async () => {
    const firstSend = (() => {
      let resolve!: () => void;
      return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
    })();
    const order: string[] = [];
    const send = vi.fn()
      .mockImplementationOnce(async () => { await firstSend.promise; order.push("send-1"); })
      .mockImplementationOnce(async () => { order.push("send-2"); });
    const finish = vi.fn(async () => { order.push("finish"); });
    let captureOptions: { onChunk: (chunk: string) => void } | undefined;
    createPcmCapture.mockImplementation(async (options) => {
      captureOptions = options as { onChunk: (chunk: string) => void };
      return { stop: vi.fn() };
    });
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram",
      deps: {
        start: vi.fn(async () => "session-queue"),
        send,
        finish,
        cancel: vi.fn(async () => {}),
      },
    });

    await provider.start();
    const capture = captureOptions as { onChunk: (chunk: string) => void } | undefined;
    capture?.onChunk("first");
    capture?.onChunk("second");
    const stopping = provider.stop();
    await nextTick();
    expect(finish).not.toHaveBeenCalled();

    firstSend.resolve();
    await stopping;

    expect(order).toEqual(["send-1", "send-2", "finish"]);
  });

  it("fails closed when renderer audio backpressure exceeds the bounded upload queue", async () => {
    const firstSend = (() => {
      let resolve!: () => void;
      return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
    })();
    let captureOptions: { onChunk: (chunk: string) => void } | undefined;
    let emit: ((event: SttStreamEvent) => void) | undefined;
    createPcmCapture.mockImplementation(async (options) => {
      captureOptions = options as { onChunk: (chunk: string) => void };
      return { stop: vi.fn() };
    });
    const onError = vi.fn();
    const finish = vi.fn(async () => emit?.({ kind: "final", transcript: "unsafe incomplete text" }));
    const cancel = vi.fn(async () => {});
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram",
      maxPendingAudioChunks: 2,
      onError,
      deps: {
        start: vi.fn(async (_id, callback) => {
          emit = callback;
          return "session-overloaded";
        }),
        send: vi.fn(async () => { await firstSend.promise; }),
        finish,
        cancel,
      },
    });

    await provider.start();
    captureOptions?.onChunk("first");
    captureOptions?.onChunk("second");
    captureOptions?.onChunk("overflow");
    const stopping = provider.stop();
    firstSend.resolve();

    await expect(stopping).rejects.toThrow(/queue.*full/i);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("queue is full"));
    expect(cancel).toHaveBeenCalledWith("session-overloaded");
    expect(finish).not.toHaveBeenCalled();
  });

  it("surfaces an audio-send failure and refuses to execute an incomplete transcript", async () => {
    let captureOptions: { onChunk: (chunk: string) => void } | undefined;
    createPcmCapture.mockImplementation(async (options) => {
      captureOptions = options as { onChunk: (chunk: string) => void };
      return { stop: vi.fn() };
    });
    const onError = vi.fn();
    const finish = vi.fn(async () => {});
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram",
      onError,
      deps: {
        start: vi.fn(async () => "session-failed"),
        send: vi.fn(async () => { throw new Error("IPC queue closed"); }),
        finish,
        cancel: vi.fn(async () => {}),
      },
    });

    await provider.start();
    const capture = captureOptions as { onChunk: (chunk: string) => void } | undefined;
    capture?.onChunk("lost audio");
    await nextTick();

    await expect(provider.stop()).rejects.toThrow(/audio upload failed/i);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("audio upload failed"));
    expect(finish).not.toHaveBeenCalled();
  });

  it("uses the short adaptive tail grace when visible text is already provider-final", async () => {
    vi.useFakeTimers();
    try {
      let emit: ((event: SttStreamEvent) => void) | undefined;
      const provider = createStreamingSttProvider("deepgram", { kind: "deepgram",
        deps: {
          start: vi.fn(async (_id, callback) => {
            emit = callback;
            return "session-settled";
          }),
          send: vi.fn(async () => {}),
          finish: vi.fn(async () => {}),
          cancel: vi.fn(async () => {}),
        },
      });
      await provider.start();
      emit?.({ kind: "final", transcript: "already final" });

      const stopping = provider.stop();
      let settled = false;
      void stopping.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(649);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(stopping).resolves.toBe("already final");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still waits for a trailing final when no live transcript exists yet", async () => {
    let onEvent: ((event: SttStreamEvent) => void) | null = null;
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram",
      deps: {
        start: vi.fn(async (_id, cb) => {
          onEvent = cb;
          return "session-2";
        }),
        send: vi.fn(async () => {}),
        finish: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
      },
    });

    await provider.start();
    const stopResult = provider.stop();
    const pending = await Promise.race([stopResult, nextTick().then(() => "still-waiting")]);
    expect(pending).toBe("still-waiting");

    const emit = onEvent as ((event: SttStreamEvent) => void) | null;
    emit?.({ kind: "final", transcript: "open terminal" });
    emit?.({ kind: "closed" });

    await expect(stopResult).resolves.toBe("open terminal");
  });
});

describe("createStreamingSttProvider — mic start failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function fakeDeps() {
    let next = 0;
    return {
      start: vi.fn(async () => `session-${++next}`),
      send: vi.fn(async () => {}),
      finish: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    };
  }

  it("cancels the backend session when the mic fails to start, and reports the mic error", async () => {
    const deps = fakeDeps();
    createPcmCapture.mockRejectedValueOnce(new Error("Permission denied"));
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram", deps });

    await expect(provider.start()).rejects.toThrow("Permission denied");

    expect(deps.cancel).toHaveBeenCalledWith("session-1");
  });

  it("works normally on the next try after a mic failure and never touches the failed session again", async () => {
    const deps = fakeDeps();
    createPcmCapture.mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce({ stop: vi.fn(async () => {}) });
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram", deps });
    await expect(provider.start()).rejects.toThrow("Permission denied");
    deps.cancel.mockClear();

    await provider.start();
    await provider.stop();

    expect(deps.start).toHaveBeenCalledTimes(2);
    expect(deps.finish).toHaveBeenCalledWith("session-2");
    expect(deps.finish).not.toHaveBeenCalledWith("session-1");
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it("cancels the session exactly once when cancel() wins the race and the mic then fails", async () => {
    const deps = fakeDeps();
    let failMic!: (error: Error) => void;
    createPcmCapture.mockReturnValueOnce(new Promise((_res, rej) => (failMic = rej)));
    const provider = createStreamingSttProvider("deepgram", { kind: "deepgram", deps });

    const starting = provider.start();
    await vi.waitFor(() => expect(createPcmCapture).toHaveBeenCalled());
    provider.cancel();
    failMic(new Error("Permission denied"));
    await expect(starting).rejects.toThrow("Permission denied");

    expect(deps.cancel).toHaveBeenCalledTimes(1);
    expect(deps.cancel).toHaveBeenCalledWith("session-1");
  });
});
