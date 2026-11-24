"use client";
import type { SttProvider, SttProviderKind } from "./stt-provider";
import type { SttStreamEvent } from "@/lib/tauri-api";
import { tauriVoicePort, type TauriVoicePort } from "./tauri-voice-port";

// TEMP DIAG (dictation truncation): remove after one live round.
let diagT0 = 0;
const diag = (msg: string) => {
  const line = `[stt-diag] +${Math.round(performance.now() - diagT0)}ms ${msg}`;
  console.info(line);
  try {
    void Promise.resolve(tauriVoicePort.debugLog(line)).catch(() => {});
  } catch {}
};
import { resamplePcm16 } from "./pcm-capture-dsp";
import { createPcmCapture, type PcmCapture } from "./pcm-capture";
import {
  createStreamingSttUploadQueue,
  type StreamingSttUploadQueue,
} from "./streaming-stt-upload-queue";
import { resolveStreamingSttFinalizationGraceMs } from "./streaming-stt-finalization-policy";

/**
 * Streaming STT adapter (Deepgram realtime) — live partial transcripts as the user speaks. Captures
 * mic audio via the Web Audio API and downsamples to 16 kHz mono PCM16 (linear16), the most
 * webview-portable format (no MediaRecorder container quirks, which bite on macOS WKWebView). Chunks
 * are base64'd and pushed to Rust, which owns the Deepgram socket + key; partials/finals stream back.
 *
 * Implements the same {@link SttProvider} contract as the batch cloud adapter, so `onInterim` lights up
 * the command bar live and `stop()` returns the settled transcript — the NL pipeline is unchanged.
 */

const TARGET_RATE = 16000;
export const DEFAULT_STREAMING_STT_MAX_PENDING_AUDIO_CHUNKS = 8;

/** Downsample mono Float32 PCM (range -1..1) at `inputRate` to Int16 PCM at `targetRate` (default
 *  16 kHz). Thin wrapper over the shared, worklet-embedded {@link resamplePcm16} — one source of truth. */
export function downsampleToPcm16(
  input: Float32Array,
  inputRate: number,
  targetRate: number = TARGET_RATE,
): Int16Array {
  return resamplePcm16(input, inputRate, targetRate);
}

/** Base64-encode an Int16 PCM buffer (little-endian) for the IPC hop. */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface StreamingSttDeps {
  start: (providerId: string, onEvent: (e: SttStreamEvent) => void) => Promise<string>;
  send: (sessionId: string, audioBase64: string) => Promise<void>;
  finish: (sessionId: string) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
}

/** The Tauri Voice Port's stream calls, in the shape this provider takes. */
export function streamingSttDepsFrom(port: TauriVoicePort): StreamingSttDeps {
  return {
    start: port.stt.streamStart,
    send: port.stt.streamSend,
    finish: port.stt.streamFinish,
    cancel: port.stt.streamCancel,
  };
}

const defaultDeps = streamingSttDepsFrom(tauriVoicePort);

export interface StreamingSttOptions {
  onInterim?: (text: string) => void;
  onError?: (message: string) => void;
  /** Live frequency-spectrum callback (0–1 per band) for the listening-border visualizer. Fed from an
   *  AnalyserNode tapped off the same mic source, sampled per animation frame. Best-effort: if the
   *  analyser can't be built it's silently skipped — transcription is never affected. */
  onSpectrum?: (bands: number[]) => void;
  /** Active + waiting renderer IPC uploads. Overflow fails closed instead of dropping speech. */
  maxPendingAudioChunks?: number;
  deps?: StreamingSttDeps;
  /** Registry kind of the provider being streamed. */
  kind: SttProviderKind;
}

export function createStreamingSttProvider(id: string, opts: StreamingSttOptions): SttProvider {
  const deps = opts.deps ?? defaultDeps;
  let capture: PcmCapture | null = null;
  let sessionId: string | null = null;
  let committed = "";
  let interim = "";
  /** Bounded ordered renderer→native upload queue. Recreated for each streaming session. */
  let uploadQueue: StreamingSttUploadQueue | null = null;
  let closedResolve: (() => void) | null = null;
  let closed: Promise<void> = Promise.resolve();
  let finishFinalResolve: (() => void) | null = null;
  let generation = 0;
  let diagChunks = 0;
  let diagStopping = false;

  const display = () => (interim ? `${committed} ${interim}`.trim() : committed.trim());

  // Release is kicked off synchronously (mic tracks end at once) but completes asynchronously; the
  // promise is kept so `stop()` can report "transcript ready AND device released", never just the former.
  let releasing: Promise<void> = Promise.resolve();

  const teardownAudio = () => {
    releasing = capture?.stop() ?? Promise.resolve();
    capture = null;
    return releasing;
  };

  const reset = () => {
    sessionId = null;
    committed = "";
    interim = "";
    uploadQueue = null;
    closedResolve = null;
    finishFinalResolve = null;
  };

  return {
    id,
    kind: opts.kind,
    isAvailable() {
      return (
        typeof navigator !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia &&
        (typeof AudioContext !== "undefined" || typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext !== "undefined")
      );
    },
    async start() {
      const ownerGeneration = ++generation;
      diagT0 = performance.now();
      diagChunks = 0;
      diagStopping = false;
      diag(`start() called provider=${id}`);
      committed = "";
      interim = "";
      uploadQueue = null;
      finishFinalResolve = null;
      closed = new Promise<void>((res) => {
        closedResolve = res;
      });
      const startedSessionId = await deps.start(id, (ev) => {
        if (generation !== ownerGeneration) return;
        diag(`event ${ev.kind}${diagStopping ? " (after stop)" : ""}${"transcript" in ev ? ` "${ev.transcript}"` : ""}${"message" in ev ? ` ${ev.message}` : ""}`);
        if (ev.kind === "partial") {
          interim = ev.transcript;
          opts.onInterim?.(display());
        } else if (ev.kind === "final") {
          committed = `${committed} ${ev.transcript}`.trim();
          interim = "";
          opts.onInterim?.(display());
          // Once stop() has requested a flush, the first subsequent final is authoritative. A final
          // emitted before stop does not resolve this waiter; the provider may still append tail audio.
          finishFinalResolve?.();
        } else if (ev.kind === "error") {
          opts.onError?.(ev.message);
        } else if (ev.kind === "closed") {
          closedResolve?.();
        }
      });
      if (generation !== ownerGeneration) {
        void deps.cancel(startedSessionId).catch(() => {});
        return;
      }
      sessionId = startedSessionId;
      diag("session opened (Deepgram socket ready); opening mic");
      uploadQueue = createStreamingSttUploadQueue({
        maxPending: opts.maxPendingAudioChunks ?? DEFAULT_STREAMING_STT_MAX_PENDING_AUDIO_CHUNKS,
        send: (chunk) => deps.send(startedSessionId, chunk),
        onFailure: (error) => {
          diag(`upload queue FAILED after ${diagChunks} chunks: ${error.message}`);
          opts.onError?.(error.message);
        },
      });

      // Mic capture, downsample (16 kHz) + PCM16 + base64 all run on the AudioWorklet render thread;
      // the main thread only forwards each ready chunk to Rust. The spectrum tap is best-effort.
      let nextCapture: PcmCapture;
      try {
        nextCapture = await createPcmCapture({
          targetRate: TARGET_RATE,
          // Raw mic: push-to-talk is half-duplex (the speech gate stops TTS before capture starts), so
          // there is no echo to cancel — and asking for cancellation would put the shared macOS device
          // pair into voice-processing mode, muffling any other call running on it.
          voiceProcessing: false,
          onChunk: (b64) => {
            if (generation !== ownerGeneration) return;
            diagChunks += 1;
            if (diagChunks === 1) diag("first mic chunk sent");
            uploadQueue?.enqueue(b64);
          },
          onSpectrum: opts.onSpectrum,
        });
      } catch (failure) {
        // The backend session is already open; a mic that never started (permission denied, no
        // device) must not leave it streaming. A cancel() that won the race already closed it.
        if (generation === ownerGeneration) {
          void deps.cancel(startedSessionId).catch(() => {});
          reset();
        }
        throw failure;
      }
      if (generation !== ownerGeneration) {
        await nextCapture.stop();
        return;
      }
      capture = nextCapture;
      diag("mic open — UI now shows Dictating/Listening");
    },
    async stop() {
      const ownerGeneration = generation;
      diagStopping = true;
      diag(`stop() called chunks=${diagChunks} (~${diagChunks * 40}ms audio) committed="${committed}" interim="${interim}"`);
      const release = teardownAudio();
      const sid = sessionId;
      const uploadsForTurn = uploadQueue;
      const closedForTurn = closed;
      if (sid) {
        try {
          await uploadsForTurn?.flush();
        } catch (failure) {
          if (generation !== ownerGeneration) {
            await release;
            return "";
          }
          await deps.cancel(sid).catch(() => {});
          reset();
          await release;
          throw failure;
        }
        if (generation !== ownerGeneration) {
          await release;
          return "";
        }
        const finishFinal = new Promise<void>((resolve) => {
          finishFinalResolve = resolve;
        });
        await deps.finish(sid);
        if (generation !== ownerGeneration) {
          await release;
          return "";
        }
        // A visible partial is still a hypothesis. Give the provider a bounded chance to flush its
        // corrected final before routing/dispatching the command; on a wedged close, the latest text
        // still fails open after the grace bound rather than hanging the UI.
        const graceMs = resolveStreamingSttFinalizationGraceMs({ committed, interim });
        diag(`finish sent; waiting up to ${graceMs}ms`);
        const winner = await Promise.race([
          finishFinal.then(() => "first final after stop"),
          closedForTurn.then(() => "socket closed"),
          new Promise<string>((r) => setTimeout(() => r(`grace timeout ${graceMs}ms`), graceMs)),
        ]);
        diag(`stop wait ended by: ${winner} interim-left="${interim}"`);
      }
      if (generation !== ownerGeneration) {
        await release;
        return "";
      }
      const result = display();
      diag(`stop() returns "${result}"`);
      reset();
      await release;
      return result;
    },
    cancel() {
      const sid = sessionId;
      generation += 1;
      teardownAudio();
      if (sid) void deps.cancel(sid).catch(() => {});
      reset();
    },
  };
}
