/**
 * Turns a burst of steps into what the agent was *doing*.
 *
 * Coalescing already stopped narration from talking over itself, but it produced a list of
 * mechanics: "editing auth, editing token, editing session". A listener does not want the steps —
 * they want the arc. "Getting the lay of the auth flow" is the same information in a form a person
 * would actually use.
 *
 * This is the smallest useful piece of Slice 7. The full working memory keeps a rolling summary
 * across minutes so a turn-end summary knows the whole arc; a burst is the same idea over a few
 * seconds, and it is the part the listener hears most often.
 */

import { SHARED_NARRATION_RULES, composeNarrationPrompt } from "../voice/narration-rules";

/** A spoken line past this is a recital. Matches the composer's budget. */
const MAX_SPOKEN_CHARS = 220;

export interface BurstIntentDeps {
  personaBody?: string;
  /** HTTP-only model call (`nlComplete`). */
  complete: (prompt: string) => Promise<string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4_000;

/** The deterministic floor: the steps, joined. Always available, never wrong, just mechanical. */
export function joinBurstLines(lines: readonly string[]): string | null {
  const kept = lines.map((line) => line.trim()).filter(Boolean);
  return kept.length ? kept.join(", ") : null;
}

function buildPrompt(lines: readonly string[], personaBody: string | undefined): string {
  return composeNarrationPrompt({
    rules: SHARED_NARRATION_RULES,
    persona: personaBody,
    task:
      `An agent just did these steps, in order:\n${lines.map((l) => `- ${l}`).join("\n")}\n\n` +
      `Say aloud, in ONE short sentence, what it was doing — the purpose the steps add up to, not ` +
      `the steps themselves. PRESENT tense if the work is clearly continuing, past tense if it ` +
      `reads as finished. Never list the steps back. Plain text only.`,
  });
}

function sanitize(raw: string): string | null {
  const first = raw.trim().split("\n")[0]?.trim() ?? "";
  const unquoted = first.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!unquoted || unquoted.length > MAX_SPOKEN_CHARS) return null;
  return unquoted;
}

function withTimeout(promise: Promise<string>, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("burst intent timed out")), ms);
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
 * One intent-level line for a burst, or the joined steps when a model is unavailable.
 *
 * A single step short-circuits: it is already an intent-level phrase ("editing auth"), so a rewrite
 * would add latency and risk for nothing.
 */
export async function composeBurstLine(
  lines: readonly string[],
  { personaBody, complete, timeoutMs = DEFAULT_TIMEOUT_MS }: BurstIntentDeps,
): Promise<string | null> {
  const fallback = joinBurstLines(lines);
  if (!fallback || lines.length < 2) return fallback;

  try {
    const raw = await withTimeout(complete(buildPrompt(lines, personaBody)), timeoutMs);
    return sanitize(raw) ?? fallback;
  } catch {
    return fallback;
  }
}
