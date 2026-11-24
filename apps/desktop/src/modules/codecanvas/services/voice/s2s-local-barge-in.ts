import { decodePcm16Base64 } from "./pcm16-stream-player";

const DEFAULT_RMS_THRESHOLD = 0.08;
const DEFAULT_SPEECH_ACTIVITY_RMS_THRESHOLD = 0.025;
const DEFAULT_MIN_TRIGGER_GAP_MS = 450;

export interface S2sLocalBargeInInput {
  audioBase64: string;
  /** True while/recently after the agent was audible; prevents normal user turns from self-triggering. */
  agentAudioRecent: boolean;
  nowMs: number;
  lastTriggerMs: number;
  rmsThreshold?: number;
  minTriggerGapMs?: number;
}

function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const n = samples[i] / 0x8000;
    sum += n * n;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Fast client-side barge-in detector for the S2S duplex loop.
 *
 * Server VAD can arrive too late: while it is deciding, the old agent audio keeps playing into the
 * room/mic and sounds like a stuck tape over the user's speech. This local guard cuts playback as
 * soon as a loud mic chunk arrives during/recently after agent audio. It is intentionally conservative
 * (high threshold + rate limit + requires recent agent audio) so ordinary listening does not trip it.
 */
export function isS2sSpeechLikeMicChunk(
  audioBase64: string,
  rmsThreshold: number = DEFAULT_SPEECH_ACTIVITY_RMS_THRESHOLD,
): boolean {
  try {
    return rms(decodePcm16Base64(audioBase64)) >= rmsThreshold;
  } catch {
    return false;
  }
}

export function shouldTriggerS2sLocalBargeIn({
  audioBase64,
  agentAudioRecent,
  nowMs,
  lastTriggerMs,
  rmsThreshold = DEFAULT_RMS_THRESHOLD,
  minTriggerGapMs = DEFAULT_MIN_TRIGGER_GAP_MS,
}: S2sLocalBargeInInput): boolean {
  if (!agentAudioRecent) return false;
  if (nowMs - lastTriggerMs < minTriggerGapMs) return false;
  return isS2sSpeechLikeMicChunk(audioBase64, rmsThreshold);
}
