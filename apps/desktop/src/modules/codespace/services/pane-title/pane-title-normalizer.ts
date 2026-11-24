const MAX_TITLE_CHARS = 48;

/**
 * Ways a model says "I could not read this", which are answers ABOUT the transcript rather than
 * titles for it. Seen live on 2026-09-21: a pane whose turn produced nothing legible came back
 * named "Transcript not readable", and it was written to the rail as if it were a title.
 */
const UNUSABLE_TITLE_MARKERS = [
  "unreadable transcript",
  "transcript unreadable",
  "unclear transcript",
  "no readable transcript",
  "transcript not readable",
  "no transcript",
  "empty transcript",
  "no output",
  "no content",
] as const;

/**
 * What a CLI prints when it cannot answer at all, matched anywhere in the title. The title
 * sidecar printed these as its answer, and "You've hit your weekly limit" named seven panes
 * (243 sidecar sessions read 2026-10-10).
 */
const CLI_ERROR_MARKERS = [
  "hit your",
  "usage limit",
  "rate limit exceeded",
  "rate limit reached",
  "not logged in",
  "please run /login",
  "invalid api key",
  "api error",
  "credit balance",
  "overloaded",
] as const;

export function terminalPaneFallbackLabel(cwd: string): string {
  const normalized = cwd.trim().replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "root";
  if (normalized === "~") return "home";
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

export function normalizePaneTitle(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, " ")
    .replace(/[.!?…]+$/g, "")
    .trim();
}

export function formatPaneTitle(input: string): string | null {
  const stripped = input.trim();
  if (!stripped) return null;

  const capitalized = stripped[0].toUpperCase() + stripped.slice(1);
  return capitalized.length > MAX_TITLE_CHARS
    ? capitalized.slice(0, MAX_TITLE_CHARS - 1) + "…"
    : capitalized;
}

export function isUnusableTerminalPaneTitle(
  title: string | null | undefined,
  fallbackLabels: ReadonlyArray<string | null | undefined> = [],
): boolean {
  const normalized = normalizePaneTitle(title);
  if (!normalized) return false;
  if (UNUSABLE_TITLE_MARKERS.some((marker) => normalized === marker)) return true;
  const lowered = (title ?? "").toLowerCase();
  if (CLI_ERROR_MARKERS.some((marker) => lowered.includes(marker))) return true;
  return fallbackLabels
    .map(normalizePaneTitle)
    .filter(Boolean)
    .some((fallback) => normalized === fallback);
}

/**
 * Does this title just say how the agent was LAUNCHED?
 *
 * Seen on screen 2026-09-21: a pane titled "Dangerously skip permissions" — the flag its CLI was
 * started with, wearing the place where the work should be named. `isUnusableTerminalPaneTitle`
 * missed it because it compares whole strings, and the title is a fragment of the command.
 *
 * The command is flattened to words first, so `--dangerously-skip-permissions` and "Dangerously
 * skip permissions" become the same three words and the containment is visible. Deliberately a
 * containment test and not a similarity score: a title that is literally part of the command line
 * is the case being caught, and anything cleverer would start rejecting real titles.
 */
export function titleEchoesLaunchCommand(
  title: string | null | undefined,
  agentCommand: string | null | undefined,
): boolean {
  const normalizedTitle = normalizePaneTitle(title);
  if (!normalizedTitle) return false;
  const words = (agentCommand ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return false;
  return words === normalizedTitle || words.includes(normalizedTitle);
}

export interface RefusedTitleContext {
  agentCommand?: string | null;
  cwd?: string | null;
  agentName?: string | null;
}

/**
 * A stored name that says nothing about the work.
 *
 * Three ways a pane ends up with one: a model answering ABOUT the transcript instead of naming it,
 * a name that only repeats the folder or the agent's own name, and a name that is the flag the CLI
 * was launched with. Two of the three were in the rail on 2026-09-21 — and one of them was ALSO
 * being advertised to every other agent through the fleet snapshot, because the judgement lived in
 * the rail and the fleet asked nobody.
 *
 * So it lives here, beside the ingredients, and every reader shares it: the rail hides such a name,
 * the fleet does not publish it, and the refine pass is allowed to replace it.
 */
/**
 * Words that carry no task: go-aheads, choices and session talk, in the two languages used here.
 * A title made only of these (plus ticket codes, single letters and numbers) names nothing. Seen in
 * Claude's own titles, 2026-10-10: "Mulai kerjakan sekarang", "Gunakan opsi A", "New session".
 */
const NO_TASK_WORDS = new Set([
  "mulai", "kerjakan", "sekarang", "oke", "ok", "okay", "kirim", "lanjut", "lanjutkan", "gunakan",
  "pakai", "opsi", "pilihan", "kandidat", "ya", "iya", "gas", "jalankan", "start", "continue", "now",
  "go", "yes", "please", "proceed", "send", "use", "option", "candidate", "new", "session", "do",
  "it", "this", "dangerously", "skip", "permissions",
]);

const TICKET_CODE = /^[a-z][a-z0-9]*-\d+$/;

/** A title built only from go-aheads, ticket codes, letters and numbers. */
export function titleNamesNoTask(title: string | null | undefined): boolean {
  const words = (title ?? "").toLowerCase().split(/[\s_]+|(?<=[a-z])-(?=[a-z])/u).filter(Boolean);
  if (words.length === 0) return false;
  return words.every(
    (word) => NO_TASK_WORDS.has(word) || TICKET_CODE.test(word) || /^(?:[a-z]|\d+)$/u.test(word),
  );
}

/**
 * Openers of an assistant talking TO the user rather than naming the work.
 *
 * Seen live 2026-10-14: a codex pane named "I'm ready to help with your coding project! Ple…" —
 * the title one-shot answered the transcript with a greeting, and the guard let it through
 * because none of the markers above is chat.
 */
const CHATTER_OPENERS = /^(?:hi|hello|hey|halo|sure|certainly|of course|absolutely|i['’]m|i am|i['’]d|i would|i['’]ll|i will|i can|let me|how can i|how may i|what would you|please)\b/u;
const CHATTER_PHRASES = ["ready to help", "happy to help", "glad to help", "how can i help", "what would you like", "let me know"] as const;

/** A title that is the assistant chatting — a greeting, an offer, or a question back to the user. */
export function titleIsAssistantChatter(title: string | null | undefined): boolean {
  const lowered = (title ?? "").trim().toLowerCase().replace(/[…]+$/u, "").trim();
  if (!lowered) return false;
  if (CHATTER_OPENERS.test(lowered)) return true;
  if (CHATTER_PHRASES.some((phrase) => lowered.includes(phrase))) return true;
  // A question to the user, not about the work: "Why does the build fail?" stays, "Can you share it?" goes.
  return lowered.endsWith("?") && /\byou(?:r)?\b/u.test(lowered);
}

export function paneTitleSaysNothing(
  title: string | null | undefined,
  { agentCommand, cwd, agentName }: RefusedTitleContext = {},
): boolean {
  const trimmed = title?.trim();
  if (!trimmed) return false;
  return (
    isUnusableTerminalPaneTitle(trimmed, [
      cwd ? terminalPaneFallbackLabel(cwd) : null,
      agentName ?? null,
    ])
    || titleEchoesLaunchCommand(trimmed, agentCommand)
    || titleNamesNoTask(trimmed)
    || titleIsAssistantChatter(trimmed)
  );
}
