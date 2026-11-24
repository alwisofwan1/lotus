import type { ScheduledStopMode } from "./pcm16-stream-player";

export interface ScheduledAudioGain {
  cancelScheduledValues(time: number): void;
  setValueAtTime(value: number, time: number): void;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
}

export interface ScheduledAudioSource {
  stop(when?: number): void;
}

export interface StopScheduledAudioSourceInput {
  now: number;
  startAt: number;
  gain: ScheduledAudioGain;
  source: ScheduledAudioSource;
  mode?: ScheduledStopMode;
  releaseSeconds: number;
}

/**
 * Stop one scheduled PCM playback chunk safely.
 *
 * Critical detail: future chunks already have a gain ramp scheduled for `startAt`. If barge-in calls
 * `source.stop(now)` without first cancelling that ramp and forcing gain to 0, some WebKit/WebAudio
 * routes can still surface the scheduled chunk later, which sounds like a stuck tape while the user is
 * speaking. The gain envelope is the authority; source.stop is a best-effort cleanup.
 */
export function stopScheduledAudioSource({
  now,
  startAt,
  gain,
  source,
  mode,
  releaseSeconds,
}: StopScheduledAudioSourceInput): void {
  gain.cancelScheduledValues(now);

  if (mode === "fade" && now >= startAt) {
    gain.setTargetAtTime(0, now, releaseSeconds / 3);
    source.stop(now + releaseSeconds);
    return;
  }

  gain.setValueAtTime(0, now);
  source.stop(now);
}
