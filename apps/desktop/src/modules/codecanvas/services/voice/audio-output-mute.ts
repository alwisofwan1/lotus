export interface AudioOutputMuteGain {
  cancelScheduledValues(time: number): void;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
}

export interface SetAudioOutputMutedInput {
  gain: AudioOutputMuteGain;
  now: number;
  muted: boolean;
}

/** Master output duck/mute envelope for duplex voice.
 *
 * This is intentionally separate from per-chunk source stop: during barge-in, WebKit/HTMLMediaElement
 * can keep a route audibly alive even after scheduled chunks are stopped. The master gain is the final
 * safety valve: while the user has the floor, output is forced to silence; when the model owns the
 * floor again, output ramps back in quickly without a click.
 */
export function setAudioOutputMuted({ gain, now, muted }: SetAudioOutputMutedInput): void {
  gain.cancelScheduledValues(now);
  gain.setTargetAtTime(muted ? 0 : 1, now, muted ? 0.01 : 0.012);
}
