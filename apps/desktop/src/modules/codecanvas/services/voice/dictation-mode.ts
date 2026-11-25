/**
 * Dictation Modes (ADR-0034, Option B) — SuperWhisper-style named styles for how a dictation is
 * cleaned before delivery. Automatic cleanup on every surface is `VoiceInputSettings.autoCleanup`
 * (off = verbatim, no model); `polish` only shows Canvas's manual Polish button. Either way, the
 * active mode shapes the polish. `clean` is the default (fix delivery, keep
 * meaning); `note` and `commit` add formatting instructions. Adding a mode = one entry here — the
 * polish prompt builder projects `promptLines` and everything downstream is unchanged.
 */
export type DictationModeId = "clean" | "note" | "commit";

export interface DictationMode {
  id: DictationModeId;
  label: string;
  description: string;
  /** Extra instruction lines appended to the base cleanup prompt. Empty for `clean`. */
  promptLines: string[];
}

export const DICTATION_MODES: Record<DictationModeId, DictationMode> = {
  clean: {
    id: "clean",
    label: "Clean",
    description: "Fix grammar, punctuation, and fillers — keep the meaning.",
    promptLines: [],
  },
  note: {
    id: "note",
    label: "Note",
    description: "Format as tidy written notes.",
    promptLines: [
      "Format the result as clean written notes: full sentences, paragraph breaks, and a bullet list where the speaker enumerates items.",
    ],
  },
  commit: {
    id: "commit",
    label: "Commit",
    description: "Shape as a conventional commit message.",
    promptLines: [
      "Format the result as a Conventional Commit: a concise `type(scope): subject` line in the imperative mood (≤72 chars), then, only if the speaker gave detail, a blank line and a short body.",
    ],
  },
};

export const DEFAULT_DICTATION_MODE: DictationModeId = "clean";

/** Resolve a possibly-unknown/undefined id to a mode, falling back to the default. */
export function resolveDictationMode(id: string | undefined | null): DictationMode {
  return DICTATION_MODES[id as DictationModeId] ?? DICTATION_MODES[DEFAULT_DICTATION_MODE];
}
