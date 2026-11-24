/**
 * The deterministic floor of the narration stack (Slice 5 of `plans/voice-narration-layer/`).
 *
 * Turns a batched {@link ProjectFlush} into one spoken line **with no model in the loop**. A richer
 * model-written summary can be layered on top later, but this is what guarantees the system always
 * has something honest to say: no API key, no network, no credit — still a sentence. Silence is not
 * an acceptable degradation for work the user asked to hear about.
 *
 * Adapted from `heardlabs/heard` (Apache-2.0) — `heard/multi_agent.py`'s tag-count formatter.
 */

import type { ProjectFlush } from "./narration-router";

/**
 * Routing tag → the word a person would use. Deliberately verbs-as-nouns ("edit", "search") so they
 * pluralise and count naturally.
 */
const TAG_VERBS: Readonly<Record<string, string>> = {
  edit: "edit",
  write: "write",
  read: "read",
  grep: "search",
  glob: "search",
  bash: "command",
  task: "delegation",
  webfetch: "fetch",
  websearch: "web search",
  notebookedit: "edit",
};

/** Spoken numbers up to a handful; past that the digit reads better than the word. */
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);

/** `tool_post_edit` → `edit`; anything unrecognised → `operation` rather than nothing. */
function verbFor(tag: string): string {
  const parts = tag.split("_");
  const rest = parts[1] === "post" || parts[1] === "pre" ? parts.slice(2) : parts.slice(1);
  return TAG_VERBS[rest.join("_")] ?? "operation";
}

function pluralize(verb: string, count: number): string {
  if (count === 1) return `${/^[aeiou]/.test(verb) ? "an" : "a"} ${verb}`;
  return `${countWord(count)} ${verb}s`;
}

export interface SummarizeFlushOptions {
  /**
   * Human project name. Omit when there is only one project in play — naming the repo on every
   * single update is itself the thing that makes narration grating.
   */
  label?: string;
}

/**
 * One spoken line for a batched flush, or `null` when there is nothing to say.
 *
 * Shape: `"Lotus: two edits, a search across two agents."` Counts, never lists — reading eight
 * filenames aloud is exactly what the narration rules forbid.
 */
export function summarizeFlush(flush: ProjectFlush, { label }: SummarizeFlushOptions): string | null {
  if (flush.events.length === 0) return null;

  const counts = new Map<string, number>();
  for (const event of flush.events) {
    const verb = verbFor(event.tag);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }

  const body = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([verb, count]) => pluralize(verb, count))
    .join(", ");

  const agents = flush.paneIds.length >= 2 ? ` across ${countWord(flush.paneIds.length)} agents` : "";
  const sentence = `${body}${agents}.`;

  if (label) return `${label[0].toUpperCase()}${label.slice(1)}: ${sentence}`;
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}`;
}
