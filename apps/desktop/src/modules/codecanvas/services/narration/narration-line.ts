/**
 * Layer 5's deterministic half: the line to speak when no model is involved.
 *
 * **Why this exists.** `NarrationEvent.neutral` is source material, not a script — its own type
 * documents that it must never be spoken verbatim. The first renderer did exactly that, so a tool
 * event read an absolute path out character by character and a turn end recited the agent's entire
 * last message (up to the payload's 1000-char cap). This module is what stands between raw material
 * and the speaker.
 *
 * It is also the **floor**. With no API key, no network and no credit, narration still says
 * something honest. Silence is not an acceptable degradation for work the user asked to hear about,
 * and failures in particular must never depend on a model being reachable.
 */

import type { NarrationEvent } from "./narration-event";

/**
 * Tag stem → how a person would say it, in the present and the past.
 *
 * Exported since `plans/agent-headlines/` — the card headline needs the same verbs this speaks, and a
 * second copy would let an agent's spoken line and its title disagree about the same tool.
 */
export const TOOL_PHRASES: Readonly<Record<string, { present: string; past: string; takesFile: boolean }>> = {
  edit: { present: "editing", past: "edited", takesFile: true },
  notebookedit: { present: "editing", past: "edited", takesFile: true },
  write: { present: "writing", past: "wrote", takesFile: true },
  read: { present: "reading", past: "read", takesFile: true },
  grep: { present: "searching", past: "searched", takesFile: false },
  glob: { present: "searching", past: "searched", takesFile: false },
  bash: { present: "running a command", past: "ran a command", takesFile: false },
  task: { present: "delegating", past: "delegated", takesFile: false },
  webfetch: { present: "fetching a page", past: "fetched a page", takesFile: false },
  websearch: { present: "searching the web", past: "searched the web", takesFile: false },
};

/** The honest answer for a tool this build has never heard of. Shared for the same reason. */
export const UNKNOWN_TOOL_PHRASE = { present: "working on something", past: "did something", takesFile: false };

/** A spoken line is one breath. Past this the template is padding, not information. */
const MAX_TEMPLATE_CHARS = 110;

/** `/repo/src/auth/login.ts` → `login`. A listener hears words, not characters. */
function shortName(filePath: string | undefined): string | null {
  const base = filePath?.split("/").filter(Boolean).pop();
  if (!base) return null;
  return base.replace(/\.[^.]+$/, "") || null;
}

/** `tool_post_edit` → `edit`; `tool_bash` → `bash`. */
function stemOf(tag: string): string {
  const parts = tag.split("_");
  const rest = parts[1] === "post" || parts[1] === "pre" ? parts.slice(2) : parts.slice(1);
  return rest.join("_");
}

/** First sentence, hard-capped. Never the whole reply. */
function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const stop = trimmed.search(/[.!?](\s|$)/);
  const sentence = stop >= 0 ? trimmed.slice(0, stop + 1) : trimmed;
  if (sentence.length <= MAX_TEMPLATE_CHARS) return sentence;
  // Cut on a word boundary — a mid-word truncation sent to TTS is how Heard shipped narration that
  // stopped mid-syllable.
  const cut = sentence.slice(0, MAX_TEMPLATE_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" ")) || cut}…`;
}

/**
 * The deterministic line for one event, or `null` when there is nothing honest to say.
 *
 * A `prompt_intent` returns `null` deliberately: reading the user's own words back at them is worse
 * than silence. Paraphrasing it into "looking into the auth bug" needs judgement, so that case
 * belongs to the model path — and stays silent when no model is reachable.
 */
export function narrationTemplateLine(event: NarrationEvent): string | null {
  if (event.tag === "tool_post_failure") return "that command failed";
  if (event.kind === "prompt_intent") return null;
  if (event.kind === "final" || event.kind === "intermediate") {
    const text = event.neutral.trim();
    return text ? firstSentence(text) : null;
  }

  const phrase = TOOL_PHRASES[stemOf(event.tag)] ?? UNKNOWN_TOOL_PHRASE;
  const verb = event.kind === "tool_post" ? phrase.past : phrase.present;
  const name = phrase.takesFile ? shortName(event.filePath) : null;
  return name ? `${verb} ${name}` : verb;
}
