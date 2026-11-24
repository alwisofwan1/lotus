/**
 * Guard against a spawn `brief` that says nothing.
 *
 * **The bug this closes.** `spawn_agent`'s `brief` is auto-submitted verbatim as the new agent's
 * first prompt. Asked to "spawn cloud code agent and codex agent" — a request with no work in it —
 * the realtime model split the utterance and handed each fragment back as that agent's brief. Both
 * new agents then burned a real model turn answering "cloud code agent".
 *
 * Instructions alone cannot close this: the model is free to fill an optional field, and a spawn
 * request with no task contains nothing *but* the runner's name for it to put there. So the check
 * is deterministic and lives on our side of the boundary.
 *
 * **Residue test.** Strip the words a spawn request is made of — the verb, the count, the runner,
 * the word "agent" — and see whether anything is left. Everything left is, by definition, something
 * the user said that the spawn request did not need. That keeps real work ("fix the auth bug") and
 * survives phrasings in either language the user speaks without enumerating them.
 */

/** Verbs that ask for an agent, English and Indonesian. */
const SPAWN_VERBS = [
  "spawn", "open", "launch", "start", "create", "add", "make", "run", "give", "get",
  "buka", "bikin", "buat", "tambah", "jalankan", "mulai", "tolong", "coba",
];

/** Words that describe the thing being spawned rather than any work for it. */
const AGENT_NOUNS = ["agent", "agents", "agen", "terminal", "terminals", "instance", "instances", "cli", "pane", "node"];

/** Runner names and the words their product names are built from. */
const RUNNER_WORDS = [
  "claude", "cloud", "claud", "code", "codex", "cursor", "gemini", "opencode", "copilot", "qwen", "aider",
];

/** Counts, articles, and glue that never carry intent on their own. */
const FILLER = [
  "a", "an", "the", "and", "or", "with", "of", "for", "me", "please", "new", "another", "some", "please",
  "dua", "satu", "tiga", "empat", "lima", "sebuah", "dan", "yang", "buat", "aja", "dong", "ya",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "both",
];

const STOPWORDS = new Set([...SPAWN_VERBS, ...AGENT_NOUNS, ...RUNNER_WORDS, ...FILLER]);

/**
 * The brief to actually send, or `null` when it only restates the spawn request.
 *
 * `runner` is included so a **custom** runner name is stripped too — otherwise every user-defined
 * runner would be a fresh blind spot the moment someone added one.
 */
export function meaningfulSpawnBrief(brief: string | undefined, runner?: string): string | null {
  const trimmed = brief?.trim();
  if (!trimmed) return null;

  const runnerWords = (runner ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const residue = trimmed
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    // A bare number ("2 claude agents") is a count, never a task.
    .filter((word) => !/^\d+$/.test(word))
    .filter((word) => !STOPWORDS.has(word))
    .filter((word) => !runnerWords.includes(word));

  // Return the ORIGINAL text, not the lowercased scratch copy — the agent should receive what the
  // user actually said.
  return residue.length > 0 ? trimmed : null;
}
