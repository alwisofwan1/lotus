/**
 * Shared narration policy for every spoken surface (Slice 0 of `plans/voice-narration-layer/`).
 *
 * Policy lives here, tone lives in the persona. Keeping the two apart means tuning what the voice
 * is allowed to say is a one-line change in this file, and authoring a persona is purely about
 * register.
 *
 * Adapted from `heardlabs/heard` (Apache-2.0) — `heard/persona.py`'s `_SHARED_NARRATION_RULES`.
 */

/**
 * The individual policy clauses, named once so every surface renders the same text.
 *
 * Both exported blocks below are composed from this table rather than hand-written, which makes it
 * structurally impossible for the compact block to drift from the full one. Deliberately free of
 * the words a tone preset owns ("warm", "teammate", the valet register) — the tone tests assert
 * those appear only when that preset is selected, and policy leaking one would flatten every preset.
 */
const CLAUSES = {
  leadWithAVerb:
    'Get to the point fast, but SAY it — don\'t headline it. Put the substance early, yet lead with a subject and a verb ("I\'ve closed the two browsers…"), never a bare noun phrase ("Browsers closed."). You are a person talking to a colleague, not a ticker scrolling headlines.',
  neverVerbatim:
    "Never read source material verbatim. It is material, not a script. One sentence in, one sentence out. A wall in — paragraphs, lists, code, logs — the takeaway out, in one or two sentences. Compress, never expand.",
  noCodeAloud:
    'Never speak code, commit hashes, file paths, command-line flags, or URLs out loud. Say what they accomplish in plain language: "the pricing page", not "src/pages/pricing.tsx". A listener hears words, not characters.',
  aggregatePaths:
    'File paths in prose: name one to three by short name; aggregate above that ("fourteen files in src/auth").',
  aggregateLists:
    'Homogeneous lists — commits, files, errors, nodes — state how many and what they share, never enumerate them. "Eight commits, mostly multi-agent fixes" beats any list read aloud.',
  coverRealPoints:
    "Tell those apart from points that ARE the substance. When distinct findings, decisions, or results are at stake, cover every one that matters, weighted by importance, woven into a few connected spoken sentences. The listener should come away knowing every important thing — three real points in one breath beats one point that drops the other two.",
  numbersAlways: "Numbers always: counts, sizes, durations.",
  keepPronouns:
    "Drop adverbs, but NOT pronouns. Speak in the first person — you are a collaborator giving an update, not a status feed.",
  tenseEncodesState:
    'Tense encodes state. While the work is happening, speak in the present ("I\'m checking the auth flow"). Once a step has finished, speak in the past ("checked the auth flow — three failures"). Present tense for in-flight, past tense for done.',
  spokenDelivery:
    "Lean content, spoken delivery. Extract only the points that matter, then voice each as a natural connected sentence — the way you would actually say it out loud, not a string of clipped fragments.",
} as const;

type ClauseKey = keyof typeof CLAUSES;

const renderClauses = (keys: readonly ClauseKey[]): string =>
  keys.map((key) => `- ${CLAUSES[key]}`).join("\n");

/** Global narration policy, prepended to a spoken surface ahead of the persona. */
export const SHARED_NARRATION_RULES = `You are speaking aloud to a developer who is working while you talk. Their attention is the bottleneck — be brief.

Rules that apply regardless of persona:
${renderClauses([
  "leadWithAVerb",
  "neverVerbatim",
  "noCodeAloud",
  "aggregatePaths",
  "aggregateLists",
  "coverRealPoints",
  "numbersAlways",
  "keepPronouns",
  "tenseEncodesState",
  "spokenDelivery",
])}`;

/**
 * The compact block for the realtime voice session, which pays for its instructions on every
 * connect. Carries only the clauses a model breaks most often while *speaking*; the prose preamble
 * and the longer editorial-judgement clauses stay in {@link SHARED_NARRATION_RULES}.
 */
export const SPOKEN_DELIVERY_RULES = `Spoken delivery rules:
${renderClauses([
  "noCodeAloud",
  "aggregatePaths",
  "aggregateLists",
  "numbersAlways",
  "keepPronouns",
  "tenseEncodesState",
])}`;

/** The ordered sections of a spoken-surface system prompt. Blank sections are dropped. */
export interface NarrationPromptParts {
  /** Global narration policy — normally {@link SHARED_NARRATION_RULES} or a subset. */
  rules?: string;
  /** Who is speaking: persona body, or a resolved tone/style line. */
  persona?: string;
  /** What to do this call: the per-event or per-command instruction. */
  task?: string;
}

/**
 * Compose a spoken-surface system prompt in the fixed order **rules → persona → task**, dropping
 * any section that is blank. Naive concatenation leaves a double break behind whenever a section
 * is empty (a pass-through persona, a call with no task block); joining avoids that.
 */
export function composeNarrationPrompt({ rules, persona, task }: NarrationPromptParts): string {
  return [rules, persona, task]
    .map((section) => section?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}
