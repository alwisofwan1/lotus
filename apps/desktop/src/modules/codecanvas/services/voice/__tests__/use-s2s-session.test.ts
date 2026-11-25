import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { S2sStreamEvent } from "@/lib/tauri-api";

// ── Transport double (Rust s2s_stream_*) ──────────────────────────────────────
const tauri = vi.hoisted(() => ({
  startImpl: undefined as undefined | (() => Promise<string>),
  close: vi.fn(),
  send: vi.fn(),
  interrupt: vi.fn(),
  toolResult: vi.fn(),
  toolResultContinues: [] as boolean[],
  update: vi.fn(),
  updateRejectOnce: undefined as undefined | Error,
  diagnostics: vi.fn(),
  diagnosticsResult: null as null | {
    queueCapacity: number;
    queueAvailable: number;
    queueUsed: number;
    enqueuedAudioChunks: number;
    droppedAudioChunks: number;
    forwardedAudioChunks: number;
  },
  startArgs: undefined as undefined | { provider: string; instructions?: string; tools?: string },
  startCalls: 0,
  lastCb: undefined as undefined | ((ev: S2sStreamEvent) => void),
}));
vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  s2sStreamStart: (provider: string, cb: (ev: S2sStreamEvent) => void, instructions?: string, tools?: string) => {
    tauri.startCalls += 1;
    tauri.startArgs = { provider, instructions, tools };
    tauri.lastCb = cb;
    return (tauri.startImpl ?? (() => Promise.resolve("sid-1")))();
  },
  s2sDebugLog: () => Promise.resolve(),
  s2sStreamClose: (sid: string) => tauri.close(sid),
  s2sStreamSend: (sid: string, b64: string) => {
    tauri.send(sid, b64);
    return Promise.resolve();
  },
  s2sStreamInterrupt: (sid: string) => {
    tauri.interrupt(sid);
    return Promise.resolve();
  },
  s2sStreamToolResult: (
    sid: string,
    callId: string,
    output: string,
    continueResponse = true,
  ) => {
    tauri.toolResult(sid, callId, output);
    tauri.toolResultContinues.push(continueResponse);
    return Promise.resolve();
  },
  s2sStreamUpdate: (sid: string, instructions?: string, tools?: string) => {
    tauri.update(sid, instructions, tools);
    if (tauri.updateRejectOnce) {
      const err = tauri.updateRejectOnce;
      tauri.updateRejectOnce = undefined;
      return Promise.reject(err);
    }
    return Promise.resolve();
  },
  s2sStreamDiagnostics: (sid: string) => {
    tauri.diagnostics(sid);
    return Promise.resolve(tauri.diagnosticsResult);
  },
}));

// ── Mic capture double (controllable resolution to exercise the orphan race) ──
const capture = vi.hoisted(() => ({
  stop: vi.fn(),
  resolveNext: undefined as undefined | ((c: { stop: () => void }) => void),
  createCalls: 0,
  autoResolve: true,
  rejectNext: undefined as undefined | Error,
  onChunk: undefined as undefined | ((base64: string) => void),
  lastOpts: undefined as undefined | { voiceProcessing?: boolean },
}));
vi.mock("@/modules/voice-core/pcm-capture", () => ({
  createPcmCapture: (opts: { onChunk: (base64: string) => void; voiceProcessing?: boolean }) => {
    capture.createCalls += 1;
    capture.onChunk = opts.onChunk;
    capture.lastOpts = opts;
    const handle = { stop: capture.stop };
    if (capture.rejectNext) return Promise.reject(capture.rejectNext);
    if (capture.autoResolve) return Promise.resolve(handle);
    return new Promise<{ stop: () => void }>((res) => {
      capture.resolveNext = () => res(handle);
    });
  },
}));

// ── Playback double (HTMLAudioElement-backed player; no real Web Audio) ────────
const player = vi.hoisted(() => ({
  createCalls: 0,
  enqueue: vi.fn(),
  interrupt: vi.fn(),
  end: vi.fn(),
  dispose: vi.fn(),
  setMuted: vi.fn(),
  active: false,
  throwOnCreate: undefined as undefined | Error,
}));
vi.mock("../s2s-playback", () => ({
  createS2sPlayback: () => {
    player.createCalls += 1;
    if (player.throwOnCreate) throw player.throwOnCreate;
    return {
      dispose: player.dispose,
      setMuted: player.setMuted,
      player: {
        enqueue: player.enqueue,
        interrupt: player.interrupt,
        end: player.end,
        get active() {
          return player.active;
        },
      },
    };
  },
}));

import { muteChunk, useS2sSession } from "../use-s2s-session";

function pcm16Base64(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((sample, i) => {
    const v = sample < 0 ? 0x10000 + sample : sample;
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  });
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

beforeEach(() => {
  tauri.startImpl = undefined;
  tauri.startCalls = 0;
  tauri.startArgs = undefined;
  tauri.close.mockClear();
  tauri.toolResult.mockClear();
  tauri.toolResultContinues = [];
  tauri.update.mockClear();
  tauri.updateRejectOnce = undefined;
  tauri.diagnostics.mockClear();
  tauri.diagnosticsResult = null;
  capture.stop.mockClear();
  capture.createCalls = 0;
  capture.autoResolve = true;
  capture.rejectNext = undefined;
  capture.resolveNext = undefined;
  capture.onChunk = undefined;
  player.createCalls = 0;
  player.enqueue.mockClear();
  player.interrupt.mockClear();
  player.end.mockClear();
  player.dispose.mockClear();
  player.setMuted.mockClear();
  player.active = false;
  player.throwOnCreate = undefined;
  tauri.lastCb = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useS2sSession — lifecycle hardening", () => {
  // Duplex is the ONE path that genuinely needs the echo canceller: the agent speaks through the
  // same speakers the mic hears. It must opt in explicitly, because the capture default is now a raw
  // mic (macOS voice-processing mode degrades every other app sharing the device pair).
  it("opens the mic with voice processing so the agent's own reply doesn't feed back", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(capture.createCalls).toBe(1));

    expect(capture.lastOpts?.voiceProcessing).toBe(true);
  });

  it("tears the whole session down on unmount — closes the socket and stops the mic (P0-1)", async () => {
    const { result, unmount } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(capture.createCalls).toBe(1)); // ready → startCapture ran

    unmount();

    expect(tauri.close).toHaveBeenCalledWith("sid-1"); // WebSocket closed, not leaked
    expect(capture.stop).toHaveBeenCalled(); // mic released
  });

  it("rejects a concurrent second start() — one player, one socket (P0-3)", async () => {
    // Hold the connect open so the second start() lands while the first is still awaiting.
    let resolveStart: (sid: string) => void = () => {};
    tauri.startImpl = () => new Promise<string>((res) => (resolveStart = res));

    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      void result.current.start(); // first — awaits the held connect
      void result.current.start(); // second — must be rejected by the start latch
      await Promise.resolve();
    });

    expect(tauri.startCalls).toBe(1);
    expect(player.createCalls).toBe(1);

    await act(async () => {
      resolveStart("sid-1");
      await Promise.resolve();
    });
  });

  it("closes a socket that connects after the user already stopped while connecting", async () => {
    let resolveStart: (sid: string) => void = () => {};
    tauri.startImpl = () => new Promise<string>((res) => (resolveStart = res));

    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      void result.current.start();
      await Promise.resolve();
    });
    expect(result.current.session.phase).toBe("connecting");

    act(() => result.current.stop());
    expect(result.current.session.phase).toBe("closed");

    await act(async () => {
      resolveStart("late-sid");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tauri.close).toHaveBeenCalledWith("late-sid");
    expect(result.current.session.phase).toBe("closed");
  });

  it("surfaces mic startup failure and tears down the connected realtime socket", async () => {
    capture.rejectNext = new Error("microphone denied");

    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });

    await waitFor(() => expect(result.current.session.phase).toBe("error"));
    expect(result.current.session.error).toContain("microphone denied");
    expect(result.current.health.mic).toBe("error");
    expect(result.current.health.lastIssue).toContain("microphone denied");
    expect(tauri.close).toHaveBeenCalledWith("sid-1");
    expect(player.dispose).toHaveBeenCalled();
  });

  it("keeps the live voice error surface visible when the realtime socket closes after an error", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => tauri.lastCb!({ kind: "error", message: "bad realtime key" } as never));
    expect(result.current.session.phase).toBe("error");

    act(() => tauri.lastCb!({ kind: "closed" } as never));

    expect(result.current.session.phase).toBe("error");
    expect(result.current.session.error).toContain("bad realtime key");
  });

  it("surfaces an unexpected realtime socket close instead of hiding live voice when the reconnect fails too", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", reconnectDelayMs: 0 }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    tauri.startImpl = () => Promise.reject(new Error("network unreachable"));
    await act(async () => {
      tauri.lastCb!({ kind: "closed" } as never);
    });

    await waitFor(() => expect(result.current.session.phase).toBe("error"));
    expect(result.current.session.error).toContain("could not reconnect");
    expect(result.current.session.error).toContain("network unreachable");
  });

  it("surfaces playback setup failure and releases the start latch so retry works", async () => {
    player.throwOnCreate = new Error("audio output blocked");

    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.session.phase).toBe("error");
    expect(result.current.session.error).toContain("audio output blocked");
    expect(result.current.health.playback).toBe("error");
    expect(tauri.startCalls).toBe(0);

    player.throwOnCreate = undefined;
    await act(async () => {
      await result.current.start();
    });

    expect(tauri.startCalls).toBe(1);
  });

  it("tracks socket, mic, playback, audio, and tool health without exposing internals", async () => {
    const onConciergeAction = vi.fn(async () => ({ ok: true, summary: "Arrange the canvas", speak: "Tidied up." }));
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onConciergeAction }));
    await act(async () => {
      await result.current.start();
    });

    await waitFor(() => expect(result.current.health.mic).toBe("active"));
    expect(result.current.health.socket).toBe("connected");
    expect(result.current.health.playback).toBe("ready");

    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "AUDIO", responseId: "resp-1" }));
    expect(result.current.health.playback).toBe("playing");
    expect(result.current.health.audioDeltas).toBe(1);

    await act(async () => {
      tauri.lastCb!({ kind: "toolCall", callId: "call-1", name: "arrange", arguments: "{}" });
      tauri.lastCb!({ kind: "responseDone" } as never);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.health.tools).toBe("ok");
    expect(result.current.health.lastTool).toBe("arrange");
    expect(JSON.stringify(result.current.health)).not.toContain("call-1");
  });

  it("executes and answers a repeated realtime call id only once", async () => {
    const onConciergeAction = vi.fn(async () => ({ ok: true, summary: "Arranged", speak: "Done." }));
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onConciergeAction }));
    await act(async () => {
      await result.current.start();
    });

    await act(async () => {
      const duplicate = { kind: "toolCall", callId: "call-duplicate", name: "arrange", arguments: "{}" } as never;
      tauri.lastCb!(duplicate);
      tauri.lastCb!(duplicate);
      tauri.lastCb!({ kind: "responseDone" } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onConciergeAction).toHaveBeenCalledTimes(1);
    expect(tauri.toolResult).toHaveBeenCalledTimes(1);
  });

  it("batches parallel tool outputs and creates one provider continuation", async () => {
    const resolvers = new Map<string, (result: { ok: true; summary: string }) => void>();
    const onConciergeAction = vi.fn((_action: unknown, call: { callId: string }) =>
      new Promise<{ ok: true; summary: string }>((resolve) => {
        resolvers.set(call.callId, resolve);
      }),
    );
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onConciergeAction }));
    await act(async () => {
      await result.current.start();
    });

    act(() => {
      tauri.lastCb!({ kind: "toolCall", callId: "call-1", name: "arrange", arguments: "{}" } as never);
      tauri.lastCb!({ kind: "toolCall", callId: "call-2", name: "focus", arguments: "{}" } as never);
      tauri.lastCb!({ kind: "responseDone" } as never);
    });

    await act(async () => {
      resolvers.get("call-1")?.({ ok: true, summary: "Arranged" });
      await Promise.resolve();
    });
    expect(tauri.toolResult).not.toHaveBeenCalled();

    await act(async () => {
      resolvers.get("call-2")?.({ ok: true, summary: "Focused" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tauri.toolResult).toHaveBeenCalledTimes(2);
    expect(tauri.toolResultContinues).toEqual([false, true]);
  });

  it("rejects a stale tool call while the user is speaking", async () => {
    const onConciergeAction = vi.fn(async () => ({ ok: true }));
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onConciergeAction }));
    await act(async () => {
      await result.current.start();
    });

    act(() => {
      tauri.lastCb!({ kind: "userSpeechStart" });
      tauri.lastCb!({ kind: "toolCall", callId: "call-stale", name: "dispatch", arguments: "{}" } as never);
    });

    expect(onConciergeAction).not.toHaveBeenCalled();
    expect(tauri.toolResult).toHaveBeenCalledTimes(1);
    expect(tauri.toolResultContinues).toEqual([false]);
    expect(JSON.parse(tauri.toolResult.mock.calls[0]![2])).toEqual({
      ok: false,
      error: "Tool call ignored because the user is still speaking.",
    });
  });

  it("polls native queue diagnostics into sanitized health", async () => {
    vi.useFakeTimers();
    tauri.diagnosticsResult = {
      queueCapacity: 96,
      queueAvailable: 91,
      queueUsed: 5,
      enqueuedAudioChunks: 20,
      droppedAudioChunks: 2,
      forwardedAudioChunks: 18,
    };
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tauri.diagnostics).toHaveBeenCalledWith("sid-1");
    expect(result.current.health.nativeQueueUsed).toBe(5);
    expect(result.current.health.nativeDroppedAudioChunks).toBe(2);
    expect(result.current.health.lastIssue).toBe("Dropped 2 mic audio chunks under load.");
    vi.useRealTimers();
  });

  it("barge-in: cuts playback when the user speaks while reply audio is still draining (post response.done)", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    // Model finished sending (phase would be "listening") but the client is STILL playing buffered
    // audio. The user starts speaking — this must stop playback even though phase !== "agent".
    player.active = true;
    player.interrupt.mockClear();
    act(() => tauri.lastCb!({ kind: "userSpeechStart" }));

    expect(player.interrupt).toHaveBeenCalled();
  });

  it("server-VAD barge-in does not send an explicit realtime cancel", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    player.active = true;
    tauri.interrupt.mockClear();
    act(() => tauri.lastCb!({ kind: "userSpeechStart" }));

    // The realtime session is configured with turn_detection.interrupt_response=true. Once the server
    // emits speech_started, it has already taken responsibility for cancelling the response; sending a
    // second response.cancel can make providers return an error/close the socket during barge-in.
    expect(tauri.interrupt).not.toHaveBeenCalled();
    expect(player.interrupt).toHaveBeenCalled();
  });

  it("barge-in keeps dropping late deltas from the cancelled response id after the user stops", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "OLD-1", responseId: "resp-old" }));
    expect(player.enqueue).toHaveBeenCalledWith("OLD-1");

    player.active = true;
    player.enqueue.mockClear();
    act(() => tauri.lastCb!({ kind: "userSpeechStart" }));
    act(() => tauri.lastCb!({ kind: "userSpeechEnd" }));

    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "OLD-LATE", responseId: "resp-old" }));
    expect(player.enqueue).not.toHaveBeenCalled();

    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "NEW", responseId: "resp-new" }));
    expect(player.enqueue).toHaveBeenCalledWith("NEW");
  });

  it("barge-in quarantines no-response-id stale reply audio briefly after the user stops", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "AAAA" }));
    expect(player.enqueue).toHaveBeenCalledWith("AAAA");

    player.active = true;
    player.enqueue.mockClear();
    act(() => tauri.lastCb!({ kind: "userSpeechStart" }));
    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "LATE" }));
    expect(player.enqueue).not.toHaveBeenCalled();

    now.mockReturnValue(1_100);
    act(() => tauri.lastCb!({ kind: "userSpeechEnd" }));
    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "NO-ID-LATE" }));
    expect(player.enqueue).not.toHaveBeenCalled();

    now.mockReturnValue(2_000);
    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "NEXT" }));
    expect(player.enqueue).toHaveBeenCalledWith("NEXT");
    now.mockRestore();
  });

  it("unmutes output once the user stops and the next agent audio is accepted", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => tauri.lastCb!({ kind: "userSpeechStart" }));
    expect(player.setMuted).toHaveBeenCalledWith(true);
    player.setMuted.mockClear();

    now.mockReturnValue(2_000);
    act(() => tauri.lastCb!({ kind: "userSpeechEnd" }));
    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "AFTER", responseId: "resp-after" }));
    expect(player.setMuted).toHaveBeenCalledWith(false);
    expect(player.enqueue).toHaveBeenCalledWith("AFTER");
    now.mockRestore();
  });

  it("drops every audio delta while server-VAD says the user is speaking", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "BEFORE", responseId: "resp-before" }));
    expect(player.enqueue).toHaveBeenCalledWith("BEFORE");

    player.enqueue.mockClear();
    act(() => tauri.lastCb!({ kind: "userSpeechStart" }));
    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "TALKOVER", responseId: "resp-new" }));
    expect(player.enqueue).not.toHaveBeenCalled();

    act(() => tauri.lastCb!({ kind: "userSpeechEnd" }));
    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "AFTER", responseId: "resp-after" }));
    expect(player.enqueue).toHaveBeenCalledWith("AFTER");
  });

  it("local mic barge-in cuts playback before server VAD responds", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(capture.onChunk).toBeDefined());
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "BEFORE", responseId: "resp-before" }));
    player.interrupt.mockClear();
    player.enqueue.mockClear();

    act(() => capture.onChunk!(pcm16Base64(new Array(64).fill(12_000))));
    expect(player.interrupt).toHaveBeenCalled();
    expect(player.setMuted).toHaveBeenCalledWith(true);
    expect(tauri.interrupt).not.toHaveBeenCalled();

    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "TALKOVER", responseId: "resp-new" }));
    expect(player.enqueue).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("a muted mic sends same-length silence and never barges in on the agent", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(capture.onChunk).toBeDefined());
    await waitFor(() => expect(tauri.lastCb).toBeDefined());
    act(() => result.current.setMicMuted(true));
    expect(result.current.micMuted).toBe(true);

    act(() => tauri.lastCb!({ kind: "audioDelta", audioBase64: "BEFORE", responseId: "resp-before" }));
    player.interrupt.mockClear();
    tauri.send.mockClear();
    const loud = pcm16Base64(new Array(64).fill(12_000));
    act(() => capture.onChunk!(loud));

    expect(player.interrupt).not.toHaveBeenCalled();
    const sent = tauri.send.mock.calls.at(-1)?.[1] as string;
    expect(sent).toHaveLength(loud.length);
    expect(sent).toBe(muteChunk(loud));
    expect(Array.from(atob(sent), (c) => c.charCodeAt(0)).every((b) => b === 0)).toBe(true);

    act(() => result.current.stop());
    expect(result.current.micMuted).toBe(false);
  });

  it("server-VAD speech start always flushes local playback without sending realtime cancel", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    player.active = false; // cursor can be idle while the media sink still has audible tail/echo.
    player.interrupt.mockClear();
    tauri.interrupt.mockClear();
    act(() => tauri.lastCb!({ kind: "userSpeechStart" }));

    expect(player.interrupt).toHaveBeenCalled();
    expect(player.setMuted).toHaveBeenCalledWith(true);
    expect(tauri.interrupt).not.toHaveBeenCalled();
  });

  it("advertises caller-provided realtime canvas tools", async () => {
    const { result } = renderHook(() =>
      useS2sSession({
        providerId: "openai",
        onConciergeAction: () => ({ ok: true }),
        realtimeTools: [
          { type: "function", name: "arrange", description: "Arrange.", parameters: { type: "object", properties: {}, required: [] } },
        ],
      }),
    );

    await act(async () => {
      await result.current.start();
    });

    expect(JSON.parse(tauri.startArgs?.tools ?? "[]")).toEqual([
      { type: "function", name: "arrange", description: "Arrange.", parameters: { type: "object", properties: {}, required: [] } },
    ]);
  });

  it("refreshes realtime instructions/tools while a live session is active", async () => {
    const { result, rerender } = renderHook(
      ({ instructions, realtimeTools }) =>
        useS2sSession({
          providerId: "openai",
          instructions,
          realtimeTools,
          onConciergeAction: () => ({ ok: true }),
        }),
      {
        initialProps: {
          instructions: "initial context",
          realtimeTools: [{ type: "function" as const, name: "focus", description: "Focus.", parameters: { type: "object", properties: {} } }],
        },
      },
    );
    await act(async () => {
      await result.current.start();
    });
    expect(tauri.update).not.toHaveBeenCalled();

    rerender({
      instructions: "updated visible agents: Bima is Claude 3",
      realtimeTools: [{ type: "function" as const, name: "dispatch", description: "Dispatch.", parameters: { type: "object", properties: {} } }],
    });
    await waitFor(() => expect(tauri.update).toHaveBeenCalledTimes(1));
    expect(tauri.update).toHaveBeenCalledWith(
      "sid-1",
      "updated visible agents: Bima is Claude 3",
      JSON.stringify([{ type: "function", name: "dispatch", description: "Dispatch.", parameters: { type: "object", properties: {} } }]),
    );
  });

  // A mid-session tool-list refresh (e.g. a project just finished loading, so switch_project should
  // now be advertised) can fail the same way session start can. Previously that failure was only a
  // console.warn — the session kept running with a silently stale tool list and no user-visible
  // signal. It must now surface into `health` the same way any other tool failure does.
  it("surfaces a failed mid-session instructions/tools refresh into health instead of failing silently", async () => {
    const { result, rerender } = renderHook(
      ({ instructions, realtimeTools }) =>
        useS2sSession({
          providerId: "openai",
          instructions,
          realtimeTools,
          onConciergeAction: () => ({ ok: true }),
        }),
      {
        initialProps: {
          instructions: "initial context",
          realtimeTools: [{ type: "function" as const, name: "focus", description: "Focus.", parameters: { type: "object", properties: {} } }],
        },
      },
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.health.tools).toBe("idle");

    tauri.updateRejectOnce = new Error("socket closed");
    rerender({
      instructions: "updated visible agents: Bima is Claude 3",
      realtimeTools: [{ type: "function" as const, name: "switch_project", description: "Switch.", parameters: { type: "object", properties: {} } }],
    });

    await waitFor(() => expect(result.current.health.tools).toBe("error"));
    expect(result.current.health.lastIssue).toContain("socket closed");
  });

  it("notifies authoritative-turn consumers when a new user speech turn starts", async () => {
    const onUserSpeechStart = vi.fn();
    const { result } = renderHook(() =>
      useS2sSession({ providerId: "openai", onUserSpeechStart }),
    );
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => tauri.lastCb!({ kind: "userSpeechStart" } as never));

    expect(onUserSpeechStart).toHaveBeenCalledTimes(1);
  });

  it("forwards only final user transcripts to the authoritative-turn callback", async () => {
    const onFinalUserTranscript = vi.fn();
    const { result } = renderHook(() =>
      useS2sSession({ providerId: "openai", onFinalUserTranscript }),
    );
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => {
      tauri.lastCb!({ kind: "transcript", text: "Agent summary", isFinal: true, speaker: "agent" } as never);
      tauri.lastCb!({ kind: "transcript", text: "Review auth", isFinal: false, speaker: "user" } as never);
      tauri.lastCb!({ kind: "transcript", text: "Review auth.ts, do not modify files.", isFinal: true, speaker: "user" } as never);
    });

    expect(onFinalUserTranscript).toHaveBeenCalledTimes(1);
    expect(onFinalUserTranscript).toHaveBeenCalledWith("Review auth.ts, do not modify files.", undefined);
  });

  // The accumulator needs the item id to REPLACE an item's refined text instead of appending it —
  // without this passthrough a cumulative provider's snapshots concatenate quadratically.
  it("forwards the transcript's itemId alongside the text when the provider sends one", async () => {
    const onFinalUserTranscript = vi.fn();
    const onUserTranscriptProgress = vi.fn();
    const { result } = renderHook(() =>
      useS2sSession({ providerId: "grok", onFinalUserTranscript, onUserTranscriptProgress }),
    );
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => {
      tauri.lastCb!({ kind: "transcript", text: "Buka", isFinal: false, speaker: "user", itemId: "itm_7" } as never);
      tauri.lastCb!({ kind: "transcript", text: "Buka file config", isFinal: true, speaker: "user", itemId: "itm_7" } as never);
    });

    act(() => {
      tauri.lastCb!({
        kind: "transcript",
        text: "Buka file config lagi",
        isFinal: false,
        speaker: "user",
        itemId: "itm_8",
        cumulative: true,
      } as never);
    });
    expect(onUserTranscriptProgress).toHaveBeenLastCalledWith("Buka file config lagi", false, {
      itemId: "itm_8",
      cumulative: true,
    });

    expect(onUserTranscriptProgress).toHaveBeenCalledWith("Buka", false, {
      itemId: "itm_7",
      cumulative: undefined,
    });
    expect(onFinalUserTranscript).toHaveBeenCalledWith("Buka file config", "itm_7");
  });

  // A failed transcription must NOT reach the reducer's `error` event: that returns a teardown effect
  // and would kill the whole duplex session over one unusable segment.
  it("surfaces a failed transcription without tearing the session down", async () => {
    const onTranscriptionFailed = vi.fn();
    const { result } = renderHook(() =>
      useS2sSession({ providerId: "openai", onTranscriptionFailed }),
    );
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => {
      tauri.lastCb!({
        kind: "transcriptionFailed",
        itemId: "itm_9",
        code: "transcription_failed",
        message: "service unavailable",
      } as never);
    });

    expect(onTranscriptionFailed).toHaveBeenCalledWith({
      itemId: "itm_9",
      code: "transcription_failed",
      message: "service unavailable",
    });
    expect(result.current.session.phase).not.toBe("error");
    expect(result.current.session.phase).not.toBe("closed");
  });

  it("forwards partial and final user transcript progress without leaking agent transcript events", async () => {
    const onUserTranscriptProgress = vi.fn();
    const { result } = renderHook(() =>
      useS2sSession({ providerId: "openai", onUserTranscriptProgress }),
    );
    await act(async () => {
      await result.current.start();
    });

    act(() => {
      tauri.lastCb!({ kind: "transcript", text: "Kirim", isFinal: false, speaker: "user" } as never);
      tauri.lastCb!({ kind: "transcript", text: "Kirim ke Atlas", isFinal: true, speaker: "user" } as never);
      tauri.lastCb!({ kind: "transcript", text: "Baik", isFinal: true, speaker: "agent" } as never);
    });

    expect(onUserTranscriptProgress.mock.calls).toEqual([
      ["Kirim", false, { itemId: undefined, cumulative: undefined }],
      ["Kirim ke Atlas", true, { itemId: undefined, cumulative: undefined }],
    ]);
  });

  it("fires onAgentFinalTranscript only for a final agent transcript, never for a final user transcript", async () => {
    const onAgentFinalTranscript = vi.fn();
    const { result } = renderHook(() =>
      useS2sSession({ providerId: "openai", onAgentFinalTranscript }),
    );
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => {
      tauri.lastCb!({ kind: "transcript", text: "Review auth.ts.", isFinal: true, speaker: "user" } as never);
    });
    expect(onAgentFinalTranscript).not.toHaveBeenCalled();

    act(() => {
      tauri.lastCb!({ kind: "transcript", text: "Reviewed, sent report.", isFinal: true, speaker: "agent" } as never);
    });
    expect(onAgentFinalTranscript).toHaveBeenCalledTimes(1);
  });

  it("keeps live voice open when the user says a sign-off phrase: only End closes it", async () => {
    const onAutoEnd = vi.fn();
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onAutoEnd }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => tauri.lastCb!({ kind: "transcript", text: "oke itu aja", isFinal: true, speaker: "user" } as never));

    expect(result.current.session.phase).toBe("listening");
    expect(tauri.close).not.toHaveBeenCalled();
    expect(onAutoEnd).not.toHaveBeenCalled();
  });

  it("does not end live voice when the agent output transcript contains a sleep phrase", async () => {
    const onAutoEnd = vi.fn();
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onAutoEnd }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    act(() => tauri.lastCb!({ kind: "transcript", text: "Say go to sleep when you want me to stop.", isFinal: true, speaker: "agent" } as never));

    expect(result.current.session.phase).toBe("listening");
    expect(onAutoEnd).not.toHaveBeenCalled();
  });

  it("ends live voice gracefully when the model calls end_conversation, after its farewell finishes", async () => {
    const onConciergeAction = vi.fn(async () => ({ ok: true, summary: "noop", speak: "noop" }));
    const onAutoEnd = vi.fn();
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onConciergeAction, onAutoEnd }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    await act(async () => {
      tauri.lastCb!({ kind: "userSpeechStart" } as never);
      tauri.lastCb!({ kind: "userSpeechEnd" } as never);
      tauri.lastCb!({ kind: "transcript", text: "oke Lotus, tidur dulu", isFinal: true, speaker: "user" } as never);
      tauri.lastCb!({ kind: "toolCall", callId: "call-end", name: "end_conversation", arguments: JSON.stringify({ farewell: "Sure — bye!" }) } as never);
      tauri.lastCb!({ kind: "responseDone" } as never);
    });
    await waitFor(() => expect(tauri.toolResult).toHaveBeenCalledWith("sid-1", "call-end", expect.stringContaining("Sure — bye!")));

    // The model's function call is answered (so it isn't left hanging) but end is NOT a canvas action.
    expect(tauri.toolResult).toHaveBeenCalledWith("sid-1", "call-end", expect.stringContaining("Sure — bye!"));
    expect(onConciergeAction).not.toHaveBeenCalled();
    // Session stays open so the spoken farewell can play — it only closes once the farewell audio ends.
    expect(result.current.session.phase).not.toBe("closed");

    act(() => tauri.lastCb!({ kind: "agentAudioEnd" } as never));

    expect(result.current.session.phase).toBe("closed");
    expect(tauri.close).toHaveBeenCalledWith("sid-1");
    expect(onAutoEnd).toHaveBeenCalledWith("voice-command", "Sure — bye!");
  });

  it("refuses end_conversation when the user's words were a request, not a sign-off", async () => {
    const onAutoEnd = vi.fn();
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onAutoEnd }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    await act(async () => {
      tauri.lastCb!({ kind: "userSpeechStart" } as never);
      tauri.lastCb!({ kind: "userSpeechEnd" } as never);
      tauri.lastCb!({ kind: "transcript", text: "itu aja yang perlu kamu cek di file config", isFinal: true, speaker: "user" } as never);
      tauri.lastCb!({ kind: "toolCall", callId: "call-end", name: "end_conversation", arguments: "{}" } as never);
      tauri.lastCb!({ kind: "responseDone" } as never);
    });

    await waitFor(() => expect(tauri.toolResult).toHaveBeenCalledWith("sid-1", "call-end", expect.stringContaining("Not ended")));
    act(() => tauri.lastCb!({ kind: "agentAudioEnd" } as never));
    expect(result.current.session.phase).not.toBe("closed");
    expect(onAutoEnd).not.toHaveBeenCalled();
  });

  it("closes after end_conversation even if the model never speaks a farewell (hard fallback)", async () => {
    vi.useFakeTimers();
    const onAutoEnd = vi.fn();
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onAutoEnd }));
    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });
    expect(tauri.lastCb).toBeDefined();

    await act(async () => {
      tauri.lastCb!({ kind: "userSpeechStart" } as never);
      tauri.lastCb!({ kind: "userSpeechEnd" } as never);
      tauri.lastCb!({ kind: "transcript", text: "oke Lotus, tidur dulu", isFinal: true, speaker: "user" } as never);
      tauri.lastCb!({ kind: "toolCall", callId: "call-end", name: "end_conversation", arguments: "{}" } as never);
      tauri.lastCb!({ kind: "responseDone" } as never);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(result.current.session.phase).not.toBe("closed");

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(result.current.session.phase).toBe("closed");
    expect(onAutoEnd).toHaveBeenCalledWith("voice-command", "Okay — ending live voice.");
    vi.useRealTimers();
  });

  it("auto-ends an idle live voice session through the normal teardown path", async () => {
    vi.useFakeTimers();
    const onAutoEnd = vi.fn();
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onAutoEnd }));
    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });
    expect(result.current.session.phase).toBe("listening");

    await act(async () => {
      vi.advanceTimersByTime(90_500);
      await Promise.resolve();
    });

    expect(result.current.session.phase).toBe("closed");
    expect(tauri.close).toHaveBeenCalledWith("sid-1");
    expect(onAutoEnd).toHaveBeenCalledWith("idle-timeout", "Live voice ended after inactivity.");
    vi.useRealTimers();
  });

  it("auto-ends after a completed tool turn when the provider stays in thinking", async () => {
    vi.useFakeTimers();
    const onAutoEnd = vi.fn();
    const onConciergeAction = vi.fn(async () => ({ ok: true, summary: "Closed everything", speak: "Closed everything." }));
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onConciergeAction, onAutoEnd }));
    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });
    expect(tauri.lastCb).toBeDefined();

    await act(async () => {
      tauri.lastCb!({ kind: "userSpeechStart" } as never);
      tauri.lastCb!({ kind: "userSpeechEnd" } as never);
      tauri.lastCb!({ kind: "toolCall", callId: "call-close", name: "close_all", arguments: "{}" } as never);
      tauri.lastCb!({ kind: "responseDone" } as never);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.session.phase).toBe("thinking");

    await act(async () => {
      vi.advanceTimersByTime(5_500);
      await Promise.resolve();
    });

    expect(result.current.session.phase).toBe("closed");
    expect(tauri.close).toHaveBeenCalledWith("sid-1");
    expect(onAutoEnd).toHaveBeenCalledWith("turn-complete", "Live voice ended.");
    vi.useRealTimers();
  });

  it("auto-ends shortly after agent audio completes and returns to listening", async () => {
    vi.useFakeTimers();
    const onAutoEnd = vi.fn();
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onAutoEnd }));
    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });
    expect(tauri.lastCb).toBeDefined();

    await act(async () => {
      tauri.lastCb!({ kind: "audioDelta", audioBase64: "AUDIO", responseId: "resp-1" } as never);
      tauri.lastCb!({ kind: "agentAudioEnd" } as never);
      await Promise.resolve();
    });
    expect(result.current.session.phase).toBe("listening");

    await act(async () => {
      // Default policy keeps a 3s post-audio grace; the 1s poll closes on the first tick after it.
      vi.advanceTimersByTime(4_100);
      await Promise.resolve();
    });

    expect(result.current.session.phase).toBe("closed");
    expect(onAutoEnd).toHaveBeenCalledWith("turn-complete", "Live voice ended.");
    vi.useRealTimers();
  });

  it("keeps the session open across turns when an injected autoEndPolicy disables per-turn auto-close", async () => {
    vi.useFakeTimers();
    const onAutoEnd = vi.fn();
    const { result } = renderHook(() =>
      useS2sSession({
        providerId: "openai",
        onAutoEnd,
        autoEndPolicy: {
          idleTimeoutMs: 90_000,
          clarificationIdleTimeoutMs: 180_000,
          listeningTurnSettleMs: 0,
          thinkingTurnSettleMs: 0,
          postAgentGraceMs: 3_000,
          maxDurationMs: 20 * 60_000,
        },
      }),
    );
    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });

    await act(async () => {
      tauri.lastCb!({ kind: "audioDelta", audioBase64: "AUDIO", responseId: "resp-1" } as never);
      tauri.lastCb!({ kind: "agentAudioEnd" } as never);
      await Promise.resolve();
    });
    expect(result.current.session.phase).toBe("listening");

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    // Per-turn auto-close is off → the session stays live for a follow-up (idle timeout is far off).
    expect(result.current.session.phase).toBe("listening");
    expect(onAutoEnd).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not auto-end while local mic speech is waiting for server VAD after agent audio", async () => {
    vi.useFakeTimers();
    const onAutoEnd = vi.fn();
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onAutoEnd }));
    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });
    expect(tauri.lastCb).toBeDefined();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(capture.onChunk).toBeDefined();

    await act(async () => {
      tauri.lastCb!({ kind: "audioDelta", audioBase64: "AUDIO", responseId: "resp-1" } as never);
      tauri.lastCb!({ kind: "agentAudioEnd" } as never);
      vi.advanceTimersByTime(1_200);
      capture.onChunk!(pcm16Base64(new Array(64).fill(12_000)));
      vi.advanceTimersByTime(1_300);
      await Promise.resolve();
    });

    expect(result.current.session.phase).toBe("listening");
    expect(tauri.close).not.toHaveBeenCalledWith("sid-1");
    expect(onAutoEnd).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("sends sanitized clarification tool results back to the S2S stream", async () => {
    const onConciergeAction = vi.fn(async () => ({
      ok: false,
      error: "Multiple agents named Claude",
      speak: "Which Claude — Sena, Nara, or Bima?",
      clarify: {
        ambiguousName: "Claude",
        question: "Which Claude — Sena, Nara, or Bima?",
        candidates: [
          { id: "uid-sena", label: "Sena" },
          { id: "uid-nara", label: "Nara" },
          { id: "uid-bima", label: "Bima" },
        ],
      },
    }));
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onConciergeAction }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    await act(async () => {
      tauri.lastCb!({ kind: "toolCall", callId: "call-clarify", name: "dispatch", arguments: "{}" });
      tauri.lastCb!({ kind: "responseDone" } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tauri.toolResult).toHaveBeenCalledWith(
      "sid-1",
      "call-clarify",
      JSON.stringify({
        ok: false,
        speak: "Which Claude — Sena, Nara, or Bima?",
        error: "Multiple agents named Claude",
        clarify: {
          ambiguousName: "Claude",
          question: "Which Claude — Sena, Nara, or Bima?",
          candidates: ["Sena", "Nara", "Bima"],
        },
      }),
    );
    expect(tauri.toolResult.mock.calls[0][2]).not.toContain("uid-bima");
  });

  it("sends sanitized realtime tool results back to the S2S stream", async () => {
    const onConciergeAction = vi.fn(async () => ({
      ok: true,
      summary: "Focused UID",
      speak: "Focused Sena.",
      delivery: "written",
      nodeId: "rf-uid-123",
    }));
    const { result } = renderHook(() => useS2sSession({ providerId: "openai", onConciergeAction }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(tauri.lastCb).toBeDefined());

    await act(async () => {
      tauri.lastCb!({ kind: "toolCall", callId: "call-1", name: "arrange", arguments: "{}" });
      tauri.lastCb!({ kind: "responseDone" } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tauri.toolResult).toHaveBeenCalledWith(
      "sid-1",
      "call-1",
      JSON.stringify({
        ok: true,
        speak: "Focused Sena.",
        summary: "Focused UID",
        delivery: "written",
      }),
    );
  });

  it("does not orphan a mic whose startCapture resolved AFTER teardown (P0-2)", async () => {
    capture.autoResolve = false; // control exactly when createPcmCapture resolves

    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start(); // → ready → startCapture begins awaiting createPcmCapture
    });
    await waitFor(() => expect(capture.createCalls).toBe(1));

    // Session torn down (user hit stop) while the mic is still being created.
    act(() => result.current.stop());

    // Now the mic finally comes up — it must be released immediately, not retained.
    await act(async () => {
      capture.resolveNext?.({ stop: capture.stop });
      await Promise.resolve();
    });

    expect(capture.stop).toHaveBeenCalled(); // the just-created, unwanted mic was stopped
  });
});

describe("useS2sSession — reconnect after a drop (Voice Core 06)", () => {
  const tools = [{ type: "function" as const, name: "focus", description: "Focus.", parameters: { type: "object", properties: {} } }];
  async function live() {
    const hook = renderHook(() =>
      useS2sSession({ providerId: "openai", instructions: "canvas context", realtimeTools: tools, onConciergeAction: () => ({ ok: true }), reconnectDelayMs: 0 }),
    );
    await act(async () => {
      await hook.result.current.start();
    });
    await waitFor(() => expect(capture.createCalls).toBe(1));
    return hook;
  }

  it("reconnects once, silently, with the same instructions and tools", async () => {
    const { result } = await live();
    const first = { ...tauri.startArgs };
    let resolveReconnect: (sid: string) => void = () => {};
    tauri.startImpl = () => new Promise((res) => (resolveReconnect = res));

    act(() => tauri.lastCb!({ kind: "closed" } as never));

    expect(result.current.session.phase).toBe("reconnecting");
    expect(result.current.session.error).toBeUndefined();
    expect(capture.stop).toHaveBeenCalled(); // the mic is closed during the gap
    expect(tauri.close).toHaveBeenCalledWith("sid-1");
    expect(tauri.startCalls).toBe(2);
    expect(tauri.startArgs).toEqual(first);

    await act(async () => {
      resolveReconnect("sid-2");
    });
    expect(result.current.session.phase).toBe("listening");
    await waitFor(() => expect(capture.createCalls).toBe(2));
  });

  it("never sends speech captured during the gap; new speech goes to the new socket", async () => {
    await live();
    const oldChunk = capture.onChunk!;
    let resolveReconnect: (sid: string) => void = () => {};
    tauri.startImpl = () => new Promise((res) => (resolveReconnect = res));
    act(() => tauri.lastCb!({ kind: "closed" } as never));
    tauri.send.mockClear();

    oldChunk(pcm16Base64([1000, -1000, 1000, -1000]));
    expect(tauri.send).not.toHaveBeenCalled();

    await act(async () => {
      resolveReconnect("sid-2");
    });
    await waitFor(() => expect(capture.createCalls).toBe(2));
    capture.onChunk!(pcm16Base64([1000, -1000]));
    expect(tauri.send).toHaveBeenCalledTimes(1);
    expect(tauri.send.mock.calls[0][0]).toBe("sid-2");
  });

  it("ignores late events from the dropped socket after reconnecting", async () => {
    const { result } = await live();
    const oldSocket = tauri.lastCb!;
    tauri.startImpl = () => Promise.resolve("sid-2");
    await act(async () => {
      oldSocket({ kind: "closed" } as never);
    });
    expect(result.current.session.phase).toBe("listening");

    act(() => oldSocket({ kind: "audioDelta", audioBase64: pcm16Base64([1, 2, 3]) } as never));
    act(() => oldSocket({ kind: "closed" } as never));
    expect(player.enqueue).not.toHaveBeenCalled();
    expect(result.current.session.phase).toBe("listening");
  });

  it("a failed reconnect shows the reason, and Retry starts a fresh session", async () => {
    const { result } = await live();
    tauri.startImpl = () => Promise.reject(new Error("network unreachable"));
    await act(async () => {
      tauri.lastCb!({ kind: "closed" } as never);
    });
    await waitFor(() => expect(result.current.session.phase).toBe("error"));
    expect(result.current.session.error).toBe("Live Voice lost its connection and could not reconnect: network unreachable");

    tauri.startImpl = () => Promise.resolve("sid-3");
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.session.phase).toBe("listening");
  });

  it("a network read error (error, then closed) reconnects instead of ending the session", async () => {
    const { result } = await live();
    const oldSocket = tauri.lastCb!;
    tauri.startImpl = () => Promise.resolve("sid-2");
    await act(async () => {
      oldSocket({ kind: "error", message: "realtime stream error: Connection reset by peer" } as never);
      oldSocket({ kind: "closed" } as never);
    });
    expect(result.current.session.phase).toBe("listening");
    expect(tauri.startCalls).toBe(2);
  });

  it("a drop right after a reconnect is the second failure: error + Retry, no endless loop", async () => {
    const { result } = await live();
    tauri.startImpl = () => Promise.resolve("sid-2");
    await act(async () => {
      tauri.lastCb!({ kind: "closed" } as never);
    });
    expect(result.current.session.phase).toBe("listening");

    await act(async () => {
      tauri.lastCb!({ kind: "closed" } as never);
    });
    expect(result.current.session.phase).toBe("error");
    expect(result.current.session.error).toContain("could not reconnect");
    expect(tauri.startCalls).toBe(2);
  });

  it("a context change during the reconnect is sent once the new socket is ready", async () => {
    const onConciergeAction = () => ({ ok: true }); // stable, like a memoised caller — no incidental re-runs
    const { result, rerender } = renderHook(
      ({ instructions }) => useS2sSession({ providerId: "openai", instructions, onConciergeAction, reconnectDelayMs: 0 }),
      { initialProps: { instructions: "nodes: A" } },
    );
    await act(async () => {
      await result.current.start();
    });
    let resolveReconnect: (sid: string) => void = () => {};
    tauri.startImpl = () => new Promise((res) => (resolveReconnect = res));
    act(() => tauri.lastCb!({ kind: "closed" } as never));
    rerender({ instructions: "nodes: A, B" });
    await new Promise((r) => setTimeout(r, 450)); // the debounce fires while there is no socket
    await act(async () => {
      resolveReconnect("sid-2");
    });
    await waitFor(() => expect(tauri.update).toHaveBeenCalledWith("sid-2", "nodes: A, B", expect.anything()));
  });

  it("End during a reconnect closes the new socket as soon as it opens", async () => {
    const { result } = await live();
    let resolveReconnect: (sid: string) => void = () => {};
    tauri.startImpl = () => new Promise((res) => (resolveReconnect = res));
    act(() => tauri.lastCb!({ kind: "closed" } as never));

    act(() => result.current.stop());
    await act(async () => {
      resolveReconnect("sid-2");
    });
    expect(result.current.session.phase).toBe("closed");
    expect(tauri.close).toHaveBeenCalledWith("sid-2");
  });
});

describe("useS2sSession — reconnect waits a moment (Voice Core 06)", () => {
  it("waits before reopening, so a short network blip can pass", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    vi.useFakeTimers();
    tauri.startImpl = () => Promise.resolve("sid-2");
    act(() => tauri.lastCb!({ kind: "closed" } as never));
    expect(result.current.session.phase).toBe("reconnecting");
    expect(tauri.startCalls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(tauri.startCalls).toBe(2);
    expect(result.current.session.phase).toBe("listening");
  });

  it("End during the wait opens no new socket", async () => {
    const { result } = renderHook(() => useS2sSession({ providerId: "openai" }));
    await act(async () => {
      await result.current.start();
    });
    vi.useFakeTimers();
    act(() => tauri.lastCb!({ kind: "closed" } as never));
    act(() => result.current.stop());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(tauri.startCalls).toBe(1);
    expect(result.current.session.phase).toBe("closed");
  });
});

describe("useS2sSession — context updates (Voice Core 06)", () => {
  it("debounces rapid context changes into one update with the latest value", async () => {
    const { result, rerender } = renderHook(
      ({ instructions }) => useS2sSession({ providerId: "openai", instructions, onConciergeAction: () => ({ ok: true }) }),
      { initialProps: { instructions: "nodes: A" } },
    );
    await act(async () => {
      await result.current.start();
    });
    vi.useFakeTimers();
    rerender({ instructions: "nodes: A, B" });
    rerender({ instructions: "nodes: A, B, C" });
    rerender({ instructions: "nodes: A, B, C, D" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(tauri.update).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(tauri.update).toHaveBeenCalledTimes(1);
    expect(tauri.update.mock.calls[0][1]).toBe("nodes: A, B, C, D");
  });

  it("sends nothing when the context changes and changes back before the debounce ends", async () => {
    const { result, rerender } = renderHook(
      ({ instructions }) => useS2sSession({ providerId: "openai", instructions, onConciergeAction: () => ({ ok: true }) }),
      { initialProps: { instructions: "nodes: A" } },
    );
    await act(async () => {
      await result.current.start();
    });
    vi.useFakeTimers();
    rerender({ instructions: "nodes: A (dragging)" });
    rerender({ instructions: "nodes: A" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(tauri.update).not.toHaveBeenCalled();
  });

  it("a new tool list object with the same value sends nothing", async () => {
    const tool = () => [{ type: "function" as const, name: "focus", description: "Focus.", parameters: { type: "object", properties: {} } }];
    const { result, rerender } = renderHook(
      ({ realtimeTools }) => useS2sSession({ providerId: "openai", instructions: "x", realtimeTools, onConciergeAction: () => ({ ok: true }) }),
      { initialProps: { realtimeTools: tool() } },
    );
    await act(async () => {
      await result.current.start();
    });
    vi.useFakeTimers();
    rerender({ realtimeTools: tool() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(tauri.update).not.toHaveBeenCalled();
  });
});
