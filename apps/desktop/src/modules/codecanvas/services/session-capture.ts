import { isClaudeFamilyRunner, type AgentRunnerType } from "@/lib/agent-runtime";

/**
 * Which freshly written CLI session belongs to *this* pane (`plans/codecanvas-session-widget/`,
 * Slice 07).
 *
 * **The race this exists to close.** Session ids are not handed to us — Claude Code ignores
 * `--session-id`, so a pane learns its own id by listing the transcript directory for its cwd before
 * launch and watching for a file that was not there before. Two agents started in the same repo
 * share a cwd, take their baselines within milliseconds of each other, and therefore both see the
 * first new transcript as "not mine before, so mine now". They both claimed it.
 *
 * Today that damage is invisible: each pane simply resumes, and nothing lists sessions to show the
 * collision. The moment a session list exists it becomes plain data corruption — one conversation
 * filed under two nodes, turn counts merged, and a resume from either one landing in the same
 * transcript.
 *
 * Two defences, and this is the first:
 *
 * 1. *here* — never offer an id this pane has already been told belongs to someone else, so a pane
 *    that loses the race keeps looking at later ids instead of stopping on a session it does not own;
 * 2. a partial UNIQUE index on `(project_id, provider_session_id)` in
 *    `codecanvas_sessions` — the storage-layer backstop for the instant where two panes write
 *    before either can read the other's claim.
 *
 * Worktrees sidestep the whole problem by giving each agent its own cwd, but they are opt-in, so
 * the shared-cwd case is the normal one.
 */

/**
 * Pick the first session id that is new since the baseline and has not already been rejected as
 * belonging to another pane.
 *
 * **The scan order is deliberately left alone.** `list_claude_sessions` returns newest first and the
 * previous code took `ids.find(...)`, i.e. the newest new id. It is tempting to switch to the oldest
 * new id on the theory that the earlier transcript belongs to the pane that launched first — but
 * nothing guarantees the two CLIs write their transcripts in launch order, so that would trade one
 * guess for another while quietly changing behaviour that works today. Order is not a signal we can
 * trust; the claim loop is what actually resolves ownership, so that is where the fix lives.
 */
export function pickCapturableSessionId(
  ids: readonly string[],
  baseline: ReadonlySet<string>,
  rejected: ReadonlySet<string> = new Set(),
): string | null {
  return ids.find((id) => !baseline.has(id) && !rejected.has(id)) ?? null;
}

/**
 * Whether a pane may learn its session id by diffing **Claude's** transcript directory.
 *
 * Only a Claude-family CLI writes there. Codex, Cursor and grok also resume, but their transcripts
 * live elsewhere, so a diff of Claude's directory can only ever show them a Claude session that
 * belongs to another pane. Seen live on 2026-10-03: a Codex agent claimed the transcript of a Claude
 * agent started in the same cwd one second later; after a restart the Codex pane tried to resume a
 * Claude id and sat dormant, and the Claude pane, refused by the unique index, came back empty.
 */
export function capturesFromClaudeTranscripts(runner: AgentRunnerType | undefined, claudeFamily?: boolean): boolean {
  return isClaudeFamilyRunner(runner, claudeFamily);
}
