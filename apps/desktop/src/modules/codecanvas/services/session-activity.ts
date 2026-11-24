import type { CanvasSessionRecord } from "./session-record";
import type { CanvasSessionStore } from "./session-store";
import { titleIsAssistantChatter } from "@/modules/codespace/services/pane-title/pane-title-normalizer";

/**
 * What an ask does to a session row (2026-09-14).
 *
 * **Why this exists.** The row was written once, at capture, and never touched again: every
 * conversation in the corner popover read `<agent> · sesi baru` with `0 turn`, days after the work
 * was done. The list was therefore unusable for its one job — telling one conversation from
 * another. Nothing was missing from the app, only from the row: `LiveAgentNode` already reconstructs
 * every ask from the PTY write stream for the headline (`pane-ask-buffer.ts`), and that is the one
 * choke point typing, paste, the submit queue and MCP dispatch all pass through. This module is
 * where that ask becomes durable.
 *
 * Pure on purpose. The writer below is four lines; the decisions — what the title becomes, when it
 * may be overwritten, how a prompt is shortened — are testable without a store, a node, or a PTY.
 */

/** How much of an ask becomes the title. Long enough to be specific, short enough for one line. */
export const SESSION_TITLE_MAX = 64;
/** How much of an ask is kept as the preview line under it. */
export const SESSION_PROMPT_MAX = 240;

/**
 * Terminal escape residue that reached the ask buffer, not something anyone typed.
 *
 * The parser's job is to keep this out (`pane-ask-buffer.ts` — SGR mouse reports leaked through a
 * too-narrow CSI parameter class until 2026-09-14). This is the second line of defence, and it
 * earns its place: a title is written ONCE and then sticks, so a single bad ask leaves a row
 * permanently named `<0;50;20M<0;50;20m…`. Recognising that shape means such a row heals itself on
 * the next real ask instead of needing to be deleted.
 *
 * Deliberately narrow: only strings made up ENTIRELY of the bytes a mouse report can contain. Real
 * prose fails this test on its first ordinary letter.
 */
const ESCAPE_RESIDUE_RE = /^[\d\s;:<=>?Mm[\]~$-]+$/;

export function looksLikeEscapeResidue(text: string): boolean {
  // The ellipsis this module adds when it truncates is not part of the residue, and leaving it on
  // is why a row titled `<0;50;20M<0;50;20m<0;4…` failed this test and stayed stuck through several
  // real asks: the stored title is the TRUNCATED form, so that is the form that must be recognised.
  const trimmed = text.trim().replace(/…+$/, "").trim();
  // A short numeric ask ("2", "y") is a real answer; residue is long and repetitive.
  return trimmed.length >= 6 && ESCAPE_RESIDUE_RE.test(trimmed);
}

/** The auto-titles created before an ask existed — replaceable the moment a real one arrives. */
export function isPlaceholderTitle(title: string): boolean {
  const trimmed = title.trim();
  return (
    trimmed === "" ||
    // "Sesi baru" is the pre-2026-11-13 Indonesian form; stored rows still carry it.
    trimmed === "Sesi baru" ||
    trimmed.endsWith("· sesi baru") ||
    trimmed === "New conversation" ||
    trimmed.endsWith("· new conversation") ||
    looksLikeEscapeResidue(trimmed)
  );
}

/** One line, no runs of whitespace — a pasted block must not become a title with newlines in it. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Cut at a word boundary when one is near the limit, so a title does not end mid-word.
  const hard = text.slice(0, max);
  const space = hard.lastIndexOf(" ");
  return `${(space > max * 0.6 ? hard.slice(0, space) : hard).trimEnd()}…`;
}

/**
 * The title an ask gives a conversation.
 *
 * A slash command keeps its slash: `/review` is exactly how the operator will remember that thread,
 * and rewriting it into prose would be inventing a summary we do not have.
 */
export function titleFromAsk(ask: string): string {
  return truncate(flatten(ask), SESSION_TITLE_MAX);
}

/**
 * Fold a new ask into a session row.
 *
 * Returns the same object when there is nothing to record, so a caller can skip the write — an
 * empty buffer must never cost a round trip to SQLite, and must never blank a good title.
 *
 * **A human's title is never overwritten.** `titleSource: "manual"` is a rename someone chose, and
 * the tenth ask of a conversation has no business undoing it. An `auto` title tracks only the FIRST
 * ask: a thread is named by what it was opened for, not by whatever was last said in it — that is
 * what the preview line underneath is for.
 */
export function applyAskToSession(
  session: CanvasSessionRecord,
  ask: string,
  now: number = Date.now(),
): CanvasSessionRecord {
  const prompt = flatten(ask);
  // Nothing typed, or nothing a person typed. Either way the row keeps what it had.
  if (!prompt || looksLikeEscapeResidue(prompt)) return session;

  const renameable = session.titleSource !== "manual" && isPlaceholderTitle(session.title);
  return {
    ...session,
    title: renameable ? titleFromAsk(prompt) : session.title,
    // `prompt` until the first reply settles; then a model refines it (`refineSessionTitle`).
    titleSource: renameable ? "prompt" : session.titleSource ?? null,
    lastPrompt: truncate(prompt, SESSION_PROMPT_MAX),
    turnCount: (session.turnCount ?? 0) + 1,
    lastActivityAt: now,
  };
}

/**
 * Persist an ask against the row a node is currently running.
 *
 * Failures are swallowed by the caller, never here: bookkeeping must not be able to disturb an agent
 * mid-turn, but a silent catch inside this function would also hide a genuinely broken store from
 * its tests.
 */
export async function recordSessionAsk(
  store: CanvasSessionStore,
  session: CanvasSessionRecord,
  ask: string,
  now: number = Date.now(),
): Promise<CanvasSessionRecord> {
  const next = applyAskToSession(session, ask, now);
  if (next === session) return session;
  await store.upsert(next);
  return next;
}

/**
 * Replace a session's title with a model's, unless a person renamed it meanwhile.
 *
 * `generate` is the slow part (a CLI one-shot), so the row is re-read after it: a rename made while
 * the model answered wins. Returns the written row, or null when nothing was written. Throws only
 * when `generate` does, so "Regenerate" can tell its caller the click did nothing.
 */
export async function refineSessionTitle(
  store: CanvasSessionStore,
  session: CanvasSessionRecord,
  generate: () => Promise<string>,
): Promise<CanvasSessionRecord | null> {
  const title = (await generate()).trim();
  if (!title || titleIsAssistantChatter(title)) return null;
  const latest = (await store.list(session.projectId)).find((s) => s.id === session.id);
  if (!latest || latest.titleSource === "manual") return null;
  const next: CanvasSessionRecord = { ...latest, title, titleSource: "auto" };
  await store.upsert(next);
  return next;
}
