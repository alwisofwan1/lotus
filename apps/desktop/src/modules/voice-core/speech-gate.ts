/**
 * Barge-in gate for the voice-feedback channel. Two things must happen the moment the user takes
 * the floor (starts a mic capture, or submits a new command that supersedes the last one):
 *
 *   1. In-flight TTS stops — `interrupt()` calls the provider's stop so speech never bleeds into
 *      the microphone or talks over the user.
 *   2. Not-yet-spoken confirmations die — composeSpokenConfirmation can take seconds; a
 *      confirmation composed for the PREVIOUS turn must not start speaking after the user has
 *      already moved on. `open()` captures the current turn; the returned sink speaks only while
 *      no interrupt has happened since.
 *
 * Stopping the provider (1) alone can't cover (2): the provider can only cancel audio it has been
 * handed, not text still being composed. The epoch guard closes that gap.
 *
 * Pure and framework-free (an epoch counter — no timers, no async). Deps are read lazily on each
 * call so callers can bind them to mutable refs (latest props) without recreating the gate.
 */

/** Per-utterance options carried through the gate (mirrors VoiceFeedback's SpeakOpts). */
export interface SpeechSinkOpts {
  /** Language of the text (BCP-47 or bare code, e.g. "id"). */
  language?: string;
}

export interface SpeechGateDeps {
  /** Speaks text through the active TTS channel. */
  speak: (text: string, opts?: SpeechSinkOpts) => void;
  /** Stops any in-flight speech (e.g. VoiceFeedback.stop). */
  stop: () => void;
}

/** Speaks the given text — unless the gate was interrupted after this sink was opened. */
export type SpeechSink = (text: string, opts?: SpeechSinkOpts) => void;

export interface SpeechGate {
  /** The user took the floor: silence in-flight speech and mute every previously opened sink. */
  interrupt: () => void;
  /** Open a sink for the current turn's confirmation (sync or resolved later). */
  open: () => SpeechSink;
}

export function createSpeechGate(deps: SpeechGateDeps): SpeechGate {
  let epoch = 0;
  return {
    interrupt: () => {
      epoch += 1;
      deps.stop();
    },
    open: () => {
      const openedAt = epoch;
      return (text: string, opts?: SpeechSinkOpts) => {
        if (epoch !== openedAt) return;
        // Preserve the caller's arity — an absent opts stays absent (keeps spy assertions honest).
        if (opts === undefined) deps.speak(text);
        else deps.speak(text, opts);
      };
    },
  };
}
