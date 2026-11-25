import type { VoiceAccuracySettings } from "@/modules/codecanvas/hooks/useVoiceAccuracySettings";
import {
  buildSttDecoderContext,
  LOTUS_VOICE_TERMS,
  type SttDecoderContext,
} from "@/modules/codecanvas/services/voice/stt-hint";
import { applyVoiceReplacements } from "@/modules/codecanvas/services/voice/voice-replacements";
import { polishDictation } from "@/modules/codecanvas/services/voice/dictation-polish";
import type { DictationModeId } from "@/modules/codecanvas/services/voice/dictation-mode";

/**
 * What Code mode gives the speech model and does to its text — the same Voice › Advanced accuracy
 * settings Canvas uses (plans/voice-transcript-quality/AUDIT.md F1, F4). Without automatic cleanup
 * both replacement stages run back to back on the raw transcript.
 *
 * Code holds a spoken turn in the composer for the user to read, so cleanup can wait longer than
 * Canvas's 900 ms delivery budget. Past it the spoken text is used as is.
 */
export const CODE_VOICE_CLEANUP_TIMEOUT_MS = 2_500;

/**
 * Decoder context for one Code turn: personal terms, Lotus's own names, then the open panes' names.
 * Languages are sent only when the user chose them in Voice settings. Canvas falls back to the
 * device language, but on a single-language model (`gpt-4o-transcribe`, `whisper-1`) that becomes a
 * hard `language=` on every turn, and Code used to auto-detect — an English-only turn must not be
 * decoded as Indonesian because the Mac is set to Indonesian.
 */
export function buildCodeVoiceDecoderContext(
  accuracy: Pick<VoiceAccuracySettings, "personalTerms" | "expectedLanguages">,
  paneNames: readonly string[],
): SttDecoderContext {
  return buildSttDecoderContext("dictate", {
    personalTerms: accuracy.personalTerms,
    canvasTerms: paneNames,
    expectedLanguages: accuracy.expectedLanguages,
  });
}

/** The user's literal corrections, applied once per stage. */
export function finalizeCodeVoiceTranscript(
  raw: string,
  accuracy: Pick<VoiceAccuracySettings, "replacements">,
): string {
  const before = applyVoiceReplacements(raw, accuracy.replacements, "before-ai");
  return applyVoiceReplacements(before, accuracy.replacements, "after-ai");
}

export interface CodeVoiceCleanupInput {
  accuracy: Pick<VoiceAccuracySettings, "personalTerms" | "replacements">;
  paneNames: readonly string[];
  mode: DictationModeId;
  callModel: (prompt: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  /** Canvas delivers straight away, so it passes its tighter budget. */
  timeoutMs?: number;
}

/**
 * Automatic cleanup for one Code turn. `spoken` is the transcript after the user's literal
 * corrections — what the composer gets back on Undo. `text` is the cleaned version, or `spoken`
 * itself when the model failed, timed out, or changed the meaning (the fidelity guard).
 */
export async function cleanUpCodeVoiceTranscript(
  raw: string,
  input: CodeVoiceCleanupInput,
): Promise<{ text: string; spoken: string }> {
  const spoken = finalizeCodeVoiceTranscript(raw, input.accuracy);
  const text = await polishDictation(raw, input.callModel, {
    mode: input.mode,
    vocabulary: [...input.accuracy.personalTerms, ...LOTUS_VOICE_TERMS, ...input.paneNames],
    replacements: input.accuracy.replacements,
    modelTimeoutMs: input.timeoutMs ?? CODE_VOICE_CLEANUP_TIMEOUT_MS,
    signal: input.signal,
  });
  return { text, spoken };
}
