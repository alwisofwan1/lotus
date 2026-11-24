/**
 * Layer 5 — the narrator. The one layer allowed to call a model.
 *
 * Everything beneath it reports facts; this decides how the work is *said*. It is what turns the
 * agent's raw last message into one short line in the persona's voice, which is the whole reason
 * `SHARED_NARRATION_RULES` (Slice 0) and the persona files (Slice 1) exist.
 *
 * **Fast-path gate.** Most events never reach the model. A tool call already has a good
 * deterministic phrase, and paying a round-trip for it would make narration trail the work it is
 * describing — Heard measured 70-80% of events bypassing the model for exactly this reason.
 *
 * **Failures never touch the model.** PLAN.md's load-bearing invariant: a dead API key must not
 * mean a regression goes by unspoken.
 */

import { SHARED_NARRATION_RULES, composeNarrationPrompt } from "../voice/narration-rules";
import type { NarrationEvent } from "./narration-event";
import { narrationTemplateLine } from "./narration-line";

export interface NarrationComposeDeps {
  /** The active persona's body — who is speaking. */
  personaBody?: string;
  /** HTTP-only model call (`nlComplete`). Never the CLI: a cold `claude --print` costs seconds. */
  complete: (prompt: string) => Promise<string>;
  /** Give up and fall back after this long — narration must follow the work, not trail it. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4_000;

/** One spoken breath. Longer than this and the model ignored the brief. */
const MAX_SPOKEN_CHARS = 220;

/** Only these carry enough substance that a rewrite earns its latency. */
function needsRewrite(event: NarrationEvent): boolean {
  if (event.tag === "tool_post_failure") return false;
  return event.kind === "final" || event.kind === "prompt_intent";
}

function buildPrompt(event: NarrationEvent, personaBody: string | undefined): string {
  const task =
    event.kind === "prompt_intent"
      ? `The user just gave their coding agent this instruction:\n"""\n${event.neutral}\n"""\n` +
        `Say aloud, in 6-10 words, what you are looking into. PRESENT tense — the work is starting. ` +
        `Do not echo or quote the instruction. Skip identifiers and paths; describe the intent plainly.`
      : `An agent just finished a step and reported:\n"""\n${event.neutral}\n"""\n` +
        `Say that aloud as one or two short spoken sentences. PAST tense — the work has happened. ` +
        `Compress; never restate it. Plain text only: no markdown, no quotes, no emoji.`;

  return composeNarrationPrompt({ rules: SHARED_NARRATION_RULES, persona: personaBody, task });
}

/** First line, unquoted; `null` when empty or a runaway. */
function sanitize(raw: string): string | null {
  const first = raw.trim().split("\n")[0]?.trim() ?? "";
  const unquoted = first.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!unquoted || unquoted.length > MAX_SPOKEN_CHARS) return null;
  return unquoted;
}

function withTimeout(promise: Promise<string>, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("narration compose timed out")), ms);
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

/**
 * The line to speak for one event, or `null` for silence.
 *
 * Fail-open by design: any model failure, timeout, or runaway output falls back to
 * {@link narrationTemplateLine}. A user with no key hears the deterministic floor, never nothing.
 */
export async function composeNarrationLine(
  event: NarrationEvent,
  { personaBody, complete, timeoutMs = DEFAULT_TIMEOUT_MS }: NarrationComposeDeps,
): Promise<string | null> {
  const fallback = narrationTemplateLine(event);
  if (!needsRewrite(event)) return fallback;

  try {
    const raw = await withTimeout(complete(buildPrompt(event, personaBody)), timeoutMs);
    return sanitize(raw) ?? fallback;
  } catch {
    return fallback;
  }
}
