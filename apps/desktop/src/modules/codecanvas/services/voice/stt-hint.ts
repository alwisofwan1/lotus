import type { VoiceMode } from "./voice-mode";

export type SttCaptureMode = VoiceMode | "auto" | "transform";

/** Keep decoder context small enough to bias recognition without overwhelming short speech. */
export const MAX_STT_HINT_CHARS = 1_200;
/** Canvas names are user-controlled. Bound their influence on the decoder prompt. */
export const MAX_STT_VOCABULARY_TERMS = 32;
const MAX_STT_TERM_CHARS = 64;
const BCP47_LANGUAGE_HINT = /^[A-Za-z]{2,3}(?:-[A-Za-z]{2}|-\d{3})?$/;

export interface SttDecoderContext {
  /** Natural-language description of the recording; never contains user-controlled vocabulary. */
  prompt: string;
  /** Ranked literal spellings expected in this turn. */
  keywords: string[];
  /** Bounded BCP-47 language hints, preserving caller priority. */
  languages: string[];
}

export interface SttDecoderContextInput {
  focusedTerms?: readonly string[];
  personalTerms?: readonly string[];
  /** Lotus's own names. Defaults to {@link LOTUS_VOICE_TERMS}; pass `[]` to leave them out. */
  productTerms?: readonly string[];
  /** Names on the surface the user is looking at: canvas nodes and agents, or Code panes. */
  canvasTerms?: readonly string[];
  expectedLanguages?: readonly string[];
}

/**
 * Names every Lotus user says that a speech model has no reason to know. Without them "Lotus Voice"
 * comes back as "di ratus voice" (plans/voice-transcript-quality/AUDIT.md F2). Ranked after the
 * user's own terms and kept short, because all scopes share the {@link MAX_STT_VOCABULARY_TERMS} cap.
 */
export const LOTUS_VOICE_TERMS: readonly string[] = [
  "Lotus",
  "Lotus Voice",
  "Lotus Canvas",
  "Claude Code",
  "Codex",
  "Tauri",
];

const COMMAND_CONTEXT =
  "Canvas command. Expected actions include: create a terminal, create a note, create an agent, " +
  "spawn a Claude agent, spawn a Codex agent, run the task, arrange the canvas, focus, close, " +
  "open a browser, recover, dispatch to, and tell.";

const MODE_CONTEXT: Record<SttCaptureMode, string> = {
  command: COMMAND_CONTEXT,
  dictate: "Technical dictation for a coding agent. Preserve the speaker's language, names, identifiers, paths, numbers, versions, and negations.",
  transform: "Editing instruction for selected text. Preserve the speaker's language and technical terms.",
  auto: "Natural speech for a coding canvas. It may be a command or technical dictation. Preserve the speaker's language and exact technical terms.",
};

function sanitizeVocabulary(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const clean = term.normalize("NFKC").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_STT_TERM_CHARS);
    if (!clean) continue;
    const key = clean.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_STT_VOCABULARY_TERMS) break;
  }
  return out;
}

function sanitizeLanguages(languages: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of languages) {
    const clean = value.trim();
    if (!BCP47_LANGUAGE_HINT.test(clean)) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 4) break;
  }
  return out;
}

/** Resolve explicit voice languages first, then a conservative device-locale fallback. */
export function resolveSttExpectedLanguages(
  configured: readonly string[],
  deviceLanguages: readonly string[] = typeof navigator !== "undefined" ? navigator.languages : [],
): string[] {
  const explicit = sanitizeLanguages(configured);
  if (explicit.length > 0) return explicit;
  const device = sanitizeLanguages(deviceLanguages);
  // If Indonesian is installed as a device language, prefer its concrete locale over a regional
  // English locale such as `en-ID`; otherwise preserve the device's own first-language priority.
  const indonesian = device.find((language) => language.split("-")[0].toLowerCase() === "id");
  return indonesian ? [indonesian] : device.slice(0, 1);
}

/** Compile provider-neutral context while preserving priority across vocabulary scopes. */
export function buildSttDecoderContext(
  mode: SttCaptureMode,
  input: SttDecoderContextInput = {},
): SttDecoderContext {
  return {
    prompt: MODE_CONTEXT[mode].slice(0, MAX_STT_HINT_CHARS),
    keywords: sanitizeVocabulary([
      ...(input.focusedTerms ?? []),
      ...(input.personalTerms ?? []),
      ...(input.productTerms ?? LOTUS_VOICE_TERMS),
      ...(input.canvasTerms ?? []),
    ]),
    languages: sanitizeLanguages(input.expectedLanguages ?? []),
  };
}

/**
 * Build bounded decoder context for one capture. Command grammar is included only when the user
 * explicitly selected Command; Auto/Dictate remain neutral so the decoder cannot invent command
 * phrases from noisy free-form speech. Canvas vocabulary is data, never instructions.
 */
export function buildSttHint(mode: SttCaptureMode, vocabulary: readonly string[]): string {
  const context = buildSttDecoderContext(mode, { productTerms: [], canvasTerms: vocabulary });
  const parts = [context.prompt, context.keywords.length ? `Vocabulary only: ${context.keywords.join(", ")}.` : ""];
  return parts.filter(Boolean).join(" ").slice(0, MAX_STT_HINT_CHARS).trim();
}
