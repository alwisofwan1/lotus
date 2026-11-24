/**
 * Streaming PCM16 playback for voice-to-voice — pure scheduler over an injected audio sink.
 *
 * Realtime S2S providers stream the model's reply as a burst of small PCM16 audio deltas
 * (`s2s_stream::S2sStreamEvent::AudioDelta`). To sound continuous, each chunk must be scheduled to
 * begin exactly where the previous one ends — a gapless timeline — and a barge-in must be able to
 * stop everything already queued. That scheduling logic lives here, decoupled from Web Audio (the
 * {@link Pcm16Sink} is injected, mirroring `cloud-tts-provider`'s injected player) so it is unit
 * testable with a fake clock.
 *
 * ADDITIVE: this is the new streaming playback path used only by voice-to-voice. The batch
 * blob-play in `cloud-tts-provider.ts` is untouched and still serves the turn-based TTS path.
 */

export type ScheduledStopMode = "immediate" | "fade";

/** A handle to one scheduled chunk — `stop()` cancels it (used for barge-in). */
export interface ScheduledSource {
  stop(mode?: ScheduledStopMode): void;
}

/** The audio primitives the player needs, abstracted for testability (real impl wraps AudioContext). */
export interface Pcm16Sink {
  /** Current audio-clock time in seconds. */
  now(): number;
  /** Schedule `samples` (PCM16) to begin at `startAt` seconds on the audio clock. */
  play(samples: Int16Array, sampleRate: number, startAt: number): ScheduledSource;
}

export interface Pcm16StreamPlayer {
  /** Decode + schedule one base64 PCM16 delta, gaplessly after whatever is already queued. */
  enqueue(base64Pcm16: string): void;
  /** The reply's audio is complete — flush any sub-threshold tail so nothing is left unplayed.
   *  Optional: the AudioContext scheduler has no tail to flush. */
  end?(): void;
  /** Barge-in: stop everything scheduled and reset the timeline. */
  interrupt(): void;
  /** True while audio is scheduled at or beyond the current clock (i.e. the agent is still speaking). */
  readonly active: boolean;
  /** Monotonic count of PCM16 samples the user has actually HEARD, for the lifetime of this player.
   *  Never reset by {@link interrupt} — take a baseline per assistant item and subtract. Optional: a
   *  sink that cannot report a playback position omits it, and callers must then treat the heard amount
   *  as unknown (0) rather than assuming the audio played. Used to compute `audio_end_ms` for
   *  `conversation.item.truncate` on barge-in. */
  readonly playedSamples?: number;
}

/** Decode base64-encoded little-endian PCM16 into an Int16Array of samples. */
export function decodePcm16Base64(base64: string): Int16Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Copy into an aligned buffer so the Int16Array view is always valid.
  const aligned = new ArrayBuffer(bytes.length - (bytes.length % 2));
  new Uint8Array(aligned).set(bytes.subarray(0, aligned.byteLength));
  return new Int16Array(aligned);
}

/**
 * Decoded byte length of a base64 PCM16 payload, without allocating the decoded buffer.
 *
 * Used to total how much assistant audio was ENQUEUED for an item, which bounds the `audio_end_ms`
 * sent with `conversation.item.truncate`. It must never over-report: an inflated total loosens that
 * clamp, and a provider rejects an `audio_end_ms` past the real audio duration.
 */
export function pcm16Base64ByteLength(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/** Default output sample rate for OpenAI-Realtime-compatible providers (Grok / OpenAI) is 24 kHz. */
export const DEFAULT_S2S_OUTPUT_SAMPLE_RATE = 24000;

export function createPcm16StreamPlayer(
  sink: Pcm16Sink,
  sampleRate: number = DEFAULT_S2S_OUTPUT_SAMPLE_RATE,
): Pcm16StreamPlayer {
  /** End time of the last scheduled chunk on the audio clock — the gapless cursor. */
  let cursor = 0;
  const sources: ScheduledSource[] = [];

  return {
    enqueue(base64Pcm16: string) {
      const samples = decodePcm16Base64(base64Pcm16);
      if (samples.length === 0) return;
      // Start where the queue ends, but never in the past (recover from underrun/first chunk).
      const startAt = Math.max(sink.now(), cursor);
      sources.push(sink.play(samples, sampleRate, startAt));
      cursor = startAt + samples.length / sampleRate;
    },
    interrupt() {
      for (const s of sources) s.stop("fade");
      sources.length = 0;
      cursor = 0;
    },
    get active() {
      return cursor > sink.now();
    },
  };
}
