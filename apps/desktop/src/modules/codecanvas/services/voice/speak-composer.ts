/**
 * Natural spoken confirmations (revises ADR-0028 §1). The Intent Registry's `speak` templates are
 * exact but robotic — fixed English gerunds regardless of the user's language. This composer asks
 * the fast BYOK NL model to phrase ONE short confirmation in the SAME language as the user's
 * request (the query text itself carries the language — no i18n table), grounded in what actually
 * happened (the template + outcome facts) so speech never overclaims.
 *
 * Fail-open by design: any model failure, empty/oversized output, or timeout falls back to the
 * template — users without a BYOK key hear exactly what they hear today. Callers must pass an
 * HTTP-only `complete` (e.g. `nlComplete`), NEVER the CLI-fallback transport: a multi-second cold
 * `claude --print` spawn is a terrible price for a confirmation sentence.
 */

import { SHARED_NARRATION_RULES, composeNarrationPrompt } from "./narration-rules";

/** Spoken-style knobs (Settings → Voice). Mirrors `VoiceOutputSettings.tone/verbosity`. */
export interface SpeakStyle {
  /** Preset shaping the confirmation's voice; "custom" uses `toneInstructions` verbatim. Absent =
   *  the product default "jarvis" (a poised, courteous AI-valet register). */
  tone?: "jarvis" | "warm" | "formal" | "brisk" | "custom";
  /** Free-text style, effective when tone is "custom" (empty → warm default). */
  toneInstructions?: string;
  /** Word budget: brief (8) / normal (12) / expressive (26 — real sentences). */
  verbosity?: "brief" | "normal" | "expressive";
}

export interface SpeakComposeInput {
  /** The user's original request — carries their language and intent. */
  query: string;
  /** The registry template (summarizeResolutions().speak) — ground truth + fallback. */
  fallback: string;
  /** Outcome facts the speech must stay honest to (e.g. "queued until the agent is ready"). */
  facts: string[];
  /** HTTP-only model call (nlComplete). Must reject fast when no BYOK key is configured. */
  complete: (prompt: string) => Promise<string>;
  /** Configured voice-input language (BCP-47) — the tie-break when the query carries no signal. */
  sttLanguage?: string;
  /** Tone + verbosity from Settings → Voice; absent = today's warm/12-word default. */
  style?: SpeakStyle;
  /** Give up and fall back after this long — speech should follow the action, not trail it. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4_000;
/** A spoken confirmation is one breath — anything longer reads as rambling. */
const MAX_SPOKEN_CHARS = 220;

// ─── Deterministic language resolution ────────────────────────────────────────
//
// The model must NEVER choose the reply language: terse commands carry almost no language signal,
// and a small model told "same language as the request" free-wheels into other languages. Code
// decides — by SCRIPT — and the prompt then COMMANDS that language.
//
// Spoken-reply languages are en / ja ONLY. Indonesian is deliberately NOT a reply language: TTS
// voices read Indonesian with anglicized, unnatural phonemes, so Indonesian input is answered in
// English. Japanese is the one non-English reply we keep, detected by KANA (the only script unique
// to Japanese). Every other script/language — Indonesian, Chinese, Korean, Arabic, … — → English.
// (STT still transcribes Indonesian speech; only the spoken REPLY drops it.)

export type SpeechLanguage = "en" | "ja";

// Unicode script tests (property escapes — unambiguous, no hand-rolled ranges).
const KANA = /[\p{sc=Hiragana}\p{sc=Katakana}]/u;
const HAN = /\p{sc=Han}/u;
const HANGUL = /\p{sc=Hangul}/u;
const LATIN_LETTER = /\p{sc=Latin}/u;
const ANY_LETTER = /\p{L}/u;

/**
 * Decide the spoken-reply language: Japanese when the text carries kana (or the configured
 * voice-input language is Japanese and the text has no script signal), English for everything else.
 * Pure and deterministic — testable, and immune to the model's multilingual drift.
 */
export function detectSpeechLanguage(query: string, fallbackLanguage?: string): SpeechLanguage {
  // Kana is the only script unique to Japanese — the sole reliable "this is Japanese" signal.
  if (KANA.test(query)) return "ja";
  // A non-Latin, non-kana script (Han/Hangul/Cyrillic/Arabic/…) is definitely NOT Japanese → English,
  // even when the configured voice-input language is Japanese (a Chinese query must not answer in ja).
  if (ANY_LETTER.test(query) && !LATIN_LETTER.test(query)) return "en";
  // Latin or letterless with no script signal: honor a configured Japanese voice-input language,
  // otherwise English. Indonesian input answers in English by product choice.
  return (fallbackLanguage?.toLowerCase() ?? "").startsWith("ja") ? "ja" : "en";
}

/**
 * Anti-slop output guard: does the model's reply actually use the commanded language's script?
 * A small model occasionally ignores the language command and answers in another language — this
 * catches the gross, script-visible cases so the caller can fall back to the honest template.
 * A Japanese reply must contain kana; a Latin-script reply (id/en) must be free of CJK/Hangul.
 * (id vs en is not verifiable by script — both Latin — but that mismatch is never the reported
 * failure; cross-script drift is.)
 */
export function spokenTextMatchesLanguage(text: string, language: SpeechLanguage): boolean {
  if (language === "ja") return KANA.test(text);
  return !KANA.test(text) && !HAN.test(text) && !HANGUL.test(text);
}

/** Word budgets per verbosity — one breath (brief), a beat (normal), or a real sentence or two. */
const VERBOSITY_WORDS: Record<NonNullable<SpeakStyle["verbosity"]>, number> = {
  brief: 8,
  normal: 12,
  expressive: 26,
};

/** The style sentence for the prompt, resolved from the tone preset (custom = user's own words). */
function styleLine(style: SpeakStyle | undefined, maxWords: number): string {
  const custom = style?.tone === "custom" ? style.toneInstructions?.trim() : "";
  if (custom) return `${custom} (max ${maxWords} words)`;
  switch (style?.tone) {
    case "warm":
      return (
        `ONE spoken confirmation, simple and warm (max ${maxWords} words) — like a friendly teammate briefly ` +
        `confirming it's handled. Keep it easy and human, never flowery or formal.`
      );
    case "formal":
      return (
        `ONE spoken confirmation, composed and professional (max ${maxWords} words) — clear and ` +
        `courteous, no slang, no exclamation.`
      );
    case "brisk":
      return (
        `ONE spoken confirmation, short and punchy (max ${maxWords} words) — efficient, ` +
        `no pleasantries, straight to what happened.`
      );
    default:
      // "jarvis" — the product default. The poised, courteous register of a refined AI valet:
      // composed and quietly warm, unfailingly polite yet economical. Deliberately NOT the eager
      // "friendly teammate" of warm — this is calm assurance with a light, gracious touch.
      return (
        `ONE spoken confirmation in the poised, courteous voice of a refined AI valet — in the manner ` +
        `of JARVIS: calm, articulate and quietly warm, unfailingly polite yet economical (max ${maxWords} words). ` +
        `Confirm what was done with composed assurance; a brief, gracious touch is welcome, never ` +
        `flowery, servile or robotic.`
      );
  }
}

export function buildSpeakPrompt(
  query: string,
  fallback: string,
  facts: string[],
  language: SpeechLanguage,
  style?: SpeakStyle,
): string {
  const factLines = facts.length ? `\nAlso true: ${facts.join("; ")}` : "";
  const languageName = language === "ja" ? "Japanese" : "English";
  const maxWords = VERBOSITY_WORDS[style?.verbosity ?? "normal"];
  // Policy first, then who is speaking, then what to say. Style ahead of policy reads as the
  // stronger instruction and the model trades the policy away to satisfy the register.
  return composeNarrationPrompt({
    rules: SHARED_NARRATION_RULES,
    persona: styleLine(style, maxWords),
    task:
      `You are the voice of an agent canvas workspace.\n` +
      `The user asked: "${query}"\n` +
      `The system just did: ${fallback}${factLines}\n` +
      `Reply in ${languageName}. Never reply in any other language.\n` +
      `Plain text only: no emoji, no markdown, no surrounding quotes. Never claim more than what the system did.`,
  });
}

/** First line, unquoted, trimmed; null when unusable (empty or runaway) → caller falls back. */
export function sanitizeSpokenText(raw: string): string | null {
  const firstLine = raw.trim().split("\n")[0]?.trim() ?? "";
  const unquoted = firstLine.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!unquoted || unquoted.length > MAX_SPOKEN_CHARS) return null;
  return unquoted;
}

export async function composeSpokenConfirmation(input: SpeakComposeInput): Promise<string> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const language = detectSpeechLanguage(input.query, input.sttLanguage);
  try {
    const raw = await withTimeout(
      input.complete(buildSpeakPrompt(input.query, input.fallback, input.facts, language, input.style)),
      timeoutMs,
    );
    const spoken = sanitizeSpokenText(raw);
    // Trust but verify: a reply in the wrong script (model ignored the command) falls back to the
    // honest template rather than speaking a language the user never asked for.
    if (spoken && spokenTextMatchesLanguage(spoken, language)) return spoken;
    return input.fallback;
  } catch {
    return input.fallback;
  }
}

function withTimeout(promise: Promise<string>, ms: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("speak compose timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
