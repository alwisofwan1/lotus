"use client";
import { PCM_CAPTURE_PROCESSOR_NAME, PCM_CAPTURE_WORKLET_URL } from "./pcm-capture-worklet-source";
import { createSpectrumSampler, type SpectrumSampler } from "./spectrum-sampler";
import { SPECTRUM_BAND_COUNT } from "./spectrum-visual";

/**
 * Off-main-thread microphone capture via AudioWorklet. The worklet resamples to `targetRate` PCM16
 * and base64-encodes it on the audio render thread; the main thread only forwards the ready string to
 * IPC. Shared by the streaming STT (16 kHz) and voice-to-voice (24 kHz) paths — the single capture
 * implementation (replaces the deprecated per-consumer `ScriptProcessorNode`, which ran on the main
 * thread and was the sustained cost behind voice "Not Responding" freezes).
 *
 * The optional spectrum tap for the listening-border visualizer runs off the SAME source and is
 * best-effort — a failure there never affects capture.
 */

export interface PcmCaptureOptions {
  /** Output sample rate: 16000 for Deepgram STT, 24000 for OpenAI-Realtime-compatible S2S. */
  targetRate: number;
  /** Called on the main thread with each ready-to-send base64 PCM16 chunk. */
  onChunk: (base64: string) => void;
  /** Optional visualizer tap (0–1 per band). */
  onSpectrum?: (bands: number[]) => void;
  /** Audio per posted chunk in ms (default 40 — equal-or-better latency than the old 4096-sample path). */
  chunkMs?: number;
  /**
   * Request the browser's echo canceller + noise suppression + auto gain (default `false`).
   *
   * Only the duplex S2S path should set this. On macOS these constraints make WebKit engage the
   * CoreAudio Voice-Processing I/O unit, which is NOT an in-process input filter: it takes over the
   * built-in input AND uses the built-in output as its echo reference, putting the shared device pair
   * into voice-chat mode. Every other app on that device pair — a Google Meet call in the browser —
   * is audibly degraded for as long as the capture lives. Push-to-talk STT never plays agent audio
   * while capturing (the speech gate stops TTS before `start()`), so it must not pay that cost.
   */
  voiceProcessing?: boolean;
}

export interface PcmCapture {
  /**
   * Stop capture and release the mic, worklet, analyser, and audio context. Idempotent.
   *
   * The mic tracks end synchronously (the device is freed as early as possible), but the returned
   * promise resolves only once the AudioContext has finished closing — until then this process still
   * holds an audio unit on the device. Await it when "released" has to be observable: UI that claims
   * the mic is off, or a caller about to open a second capture on the same device.
   */
  stop: () => Promise<void>;
}

function audioContextCtor(): typeof AudioContext {
  return typeof AudioContext !== "undefined"
    ? AudioContext
    : (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
}

export async function createPcmCapture(opts: PcmCaptureOptions): Promise<PcmCapture> {
  const ctx = new (audioContextCtor())();
  // Progressively-acquired resources, tracked in outer scope so a mid-setup failure can release
  // everything already opened. Without this, a throw AFTER getUserMedia (a worklet load failure in
  // WKWebView is realistic) rejects before returning the `stop` handle — and the live mic stream +
  // AudioContext could never be released (the caller has nothing to call). See P0-4.
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let mute: GainNode | null = null;
  let spectrum: SpectrumSampler | null = null;

  const releasePartial = (): Promise<void> => {
    try {
      spectrum?.stop();
    } catch {
      /* ignore */
    }
    try {
      if (node) {
        node.port.onmessage = null;
        node.disconnect();
      }
    } catch {
      /* ignore */
    }
    try {
      mute?.disconnect();
      source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    // Reported back so callers can await the FULL release, not just the synchronous track teardown.
    return ctx.close().catch(() => {});
  };

  try {
    // Capture starts from a user gesture (mic click / hotkey), so resuming a suspended context is allowed.
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* non-fatal */
      }
    }

    // For duplex voice-to-voice the echo canceller is essential: without it the agent's own spoken
    // reply (played through the speakers) leaks back into the mic, re-triggers server VAD, and — with
    // interrupt_response on — cancels the reply mid-sentence, producing the "thinking → back, never
    // speaks" churn. Everywhere else it is a system-wide cost, not a free win — see `voiceProcessing`.
    const voiceProcessing = opts.voiceProcessing ?? false;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: voiceProcessing,
        noiseSuppression: voiceProcessing,
        autoGainControl: voiceProcessing,
      },
    });
    source = ctx.createMediaStreamSource(stream);

    await ctx.audioWorklet.addModule(PCM_CAPTURE_WORKLET_URL);
    node = new AudioWorkletNode(ctx, PCM_CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: opts.targetRate, chunkMs: opts.chunkMs ?? 40 },
    });
    node.port.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string" && e.data.length > 0) opts.onChunk(e.data);
    };

    source.connect(node);
    // A node only runs while on a path to the destination; route through a muted gain so `process()`
    // fires without playing the mic back through the speakers (same trick the old ScriptProcessor used).
    mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);

    if (opts.onSpectrum) {
      try {
        spectrum = createSpectrumSampler({
          context: ctx,
          source,
          bandCount: SPECTRUM_BAND_COUNT,
          onSpectrum: opts.onSpectrum,
        });
        spectrum.start();
      } catch (err) {
        console.warn("[voice] spectrum tap unavailable:", err);
        spectrum = null;
      }
    }
  } catch (err) {
    await releasePartial();
    throw err;
  }

  let releasing: Promise<void> | null = null;
  return {
    stop() {
      // Idempotent: repeat calls join the first release rather than starting a second teardown.
      releasing ??= releasePartial();
      return releasing;
    },
  };
}
