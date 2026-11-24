"use client";
import { setAudioOutputMuted } from "./audio-output-mute";
import { stopScheduledAudioSource } from "./audio-stop-envelope";
import { createPcm16StreamPlayer, type Pcm16StreamPlayer, type ScheduledStopMode } from "./pcm16-stream-player";

/**
 * Seamless voice-to-voice playback = gapless Web Audio scheduling routed through an HTMLMediaElement.
 *
 * WHY THIS SHAPE (not plain AudioContext.destination, not chained <audio> WAV segments):
 *   • Gapless streaming needs sample-accurate scheduling — `AudioBufferSourceNode`s started exactly
 *     where the previous chunk ends on the audio clock. Chaining discrete `<audio>` elements (the
 *     earlier fix) leaves a start-latency gap at every segment boundary → the choppy/stuttering audio.
 *   • But macOS WKWebView is unreliable at emitting `AudioContext.destination` straight to the speakers
 *     (Apple dev-forum / WebKit) — whereas HTMLMediaElement playback is proven to work here (the TTS
 *     path). So we connect the scheduled sources to a `MediaStreamAudioDestinationNode` and play its
 *     stream through an `<audio>` element: gapless scheduling + the proven output sink.
 *
 * The gapless scheduling itself lives in the already-tested `createPcm16StreamPlayer`; this module is
 * the thin Web Audio + MediaStream backend it schedules onto.
 */

export interface S2sPlayback {
  /** The streaming player the session hook drives (enqueue / interrupt / active). */
  player: Pcm16StreamPlayer;
  /** Master output mute while the user owns the floor; stronger than per-chunk stop. */
  setMuted(muted: boolean): void;
  /** Release the audio element + AudioContext. Idempotent. */
  dispose(): void;
}

function audioContextCtor(): typeof AudioContext {
  return typeof AudioContext !== "undefined"
    ? AudioContext
    : (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
}

/**
 * Build the playback backend. MUST be called from a user gesture (the session `start()` runs from the
 * ⌘⇧L click/hotkey) so `audio.play()` is permitted and the output is unlocked. `sampleRate` is the
 * provider's PCM rate (24 kHz for OpenAI/Grok). `onDiag` surfaces play/route outcomes for the
 * `LOTUS_S2S_DEBUG` trace.
 */
export function createS2sPlayback(sampleRate: number, onDiag?: (msg: string) => void): S2sPlayback {
  const ctx = new (audioContextCtor())();
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});

  // Route scheduled audio into a MediaStream and play it via HTMLMediaElement (the WKWebView-safe
  // output), instead of ctx.destination.
  const dest = ctx.createMediaStreamDestination();
  const masterGain = ctx.createGain();
  masterGain.connect(dest);
  const audio = new Audio();
  audio.srcObject = dest.stream;
  audio.autoplay = true;
  void audio
    .play()
    .then(() => onDiag?.("stream audio playing"))
    .catch((e) => onDiag?.(`stream audio play rejected: ${e instanceof Error ? e.message : String(e)}`));

  const player = createPcm16StreamPlayer(
    {
      now: () => ctx.currentTime,
      play: (samples, rate, startAt) => {
        const buffer = ctx.createBuffer(1, samples.length, rate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        const attackSeconds = 0.004;
        const releaseSeconds = 0.018;
        src.buffer = buffer;
        src.connect(gain);
        gain.connect(masterGain); // → MediaStream, NOT ctx.destination
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(1, startAt + attackSeconds);
        src.start(startAt);
        return {
          stop: (mode?: ScheduledStopMode) => {
            try {
              stopScheduledAudioSource({
                now: ctx.currentTime,
                startAt,
                gain: gain.gain,
                source: src,
                mode,
                releaseSeconds,
              });
            } catch {
              /* already stopped */
            }
          },
        };
      },
    },
    sampleRate,
  );

  let disposed = false;
  return {
    player,
    setMuted: (muted: boolean) => {
      setAudioOutputMuted({ gain: masterGain.gain, now: ctx.currentTime, muted });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      player.interrupt();
      try {
        audio.pause();
        audio.srcObject = null;
      } catch {
        /* ignore */
      }
      // Closing the context does not end the destination node's tracks — without this they stay in
      // `live` state and the session's media track outlives the session.
      try {
        dest.stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      void ctx.close().catch(() => {});
    },
  };
}
