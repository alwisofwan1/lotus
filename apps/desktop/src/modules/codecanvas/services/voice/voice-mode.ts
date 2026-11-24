/**
 * Voice input types for the NL command bar. `VoiceMode` is an explicit one-capture override:
 * `command` drives the canvas through the NL pipeline, while `dictate` delivers to the focused agent.
 * Without a shortcut override, each mic turn starts in Auto and the Voice Intent Router infers the
 * outcome from the Canvas Voice Context (ADR-0034). No mode is persisted across turns.
 */
import type { DictationModeId } from "./dictation-mode";

/** Explicit one-capture override from the remappable Command/Dictate hotkeys; ordinary capture is Auto. */
export type VoiceMode = "command" | "dictate";

export interface VoiceInputSettings {
  /** Command outcome: run the transcript through the NL pipeline on finalize (vs insert-and-edit). */
  autoSubmit: boolean;
  /** Word floor below which a command is inserted, not executed — guards against a stray short word. */
  minWordsToSubmit: number;
  /** Show the explicit text-polish action in the command bar. */
  polish: boolean;
  /** Clean up every dictated turn with the language model before it is shown or sent (off by default).
   *  Fails open to the spoken text; where the text is held for review, one click puts the spoken text
   *  back (plans/voice-transcript-quality). Commands are never cleaned up. */
  autoCleanup: boolean;
  /** Which Dictation Mode shapes the polish when it's on (clean | note | commit). */
  dictationMode: DictationModeId;
  /** **Send Right Away** (ADR-0064), for every mode: a spoken message to an agent is sent as soon as
   *  you stop speaking. Off (default) it waits unsent so you can check it, then you press Enter. */
  sendRightAway: boolean;
}

export const DEFAULT_VOICE_INPUT: VoiceInputSettings = {
  autoSubmit: true,
  minWordsToSubmit: 2,
  polish: true,
  autoCleanup: false,
  dictationMode: "clean",
  sendRightAway: false,
};
