import type { CanvasSessionRecord } from "./session-record";
import { isPlaceholderTitle, looksLikeEscapeResidue } from "./session-activity";

/**
 * How the session list reads (`plans/codecanvas-session-widget/`, Slice 02).
 *
 * **The split between running and saved is load-bearing, not cosmetic.** A PTY survives a project
 * switch — leaving project A for project B does not kill A's agents — so a conversation can be very
 * much alive while its board is nowhere on screen. Offer "resume" on one of those and the user gets
 * a second CLI for a conversation that already had one. Running sessions therefore take you *to*
 * the work; only sessions with nothing behind them offer to start something.
 */

export interface SessionGroup {
  key: "running" | "today" | "yesterday" | "earlier";
  /** Shown as the small label above the rows. */
  label: string;
  sessions: CanvasSessionRecord[];
}

const GROUP_LABELS: Record<SessionGroup["key"], string> = {
  running: "Running",
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

/**
 * The rows the project-wide list shows.
 *
 * Conversations a graph run started are execution artefacts, not work someone will come back to:
 * one run of five agents would otherwise push five days of real conversations out of view. They
 * stay in the database (and in their node's own list) — they just do not compete for this one
 * (`plans/codecanvas-session-widget/`, Slice 10).
 */
export function sessionsForProjectList(sessions: readonly CanvasSessionRecord[]): CanvasSessionRecord[] {
  return sessions.filter((s) => s.origin !== "graph-run");
}

/**
 * Split sessions into the bands a list shows, newest activity first within each.
 *
 * Running stays its own band on purpose: those rows take you *to* a process, everything else starts
 * one. The rest is grouped by calendar day, because "when did I last touch it" is how people look
 * for a conversation. A detached row is never running, whatever its status says — it has no node.
 */
export function groupSessionsByTime(
  sessions: readonly CanvasSessionRecord[],
  now: number = Date.now(),
): SessionGroup[] {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday - 1).setHours(0, 0, 0, 0);
  const keyOf = (s: CanvasSessionRecord): SessionGroup["key"] => {
    if (s.status === "live" && s.nodeId) return "running";
    if (s.lastActivityAt >= startOfToday) return "today";
    if (s.lastActivityAt >= startOfYesterday) return "yesterday";
    return "earlier";
  };
  const byRecency = [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return (Object.keys(GROUP_LABELS) as SessionGroup["key"][])
    .map((key) => ({ key, label: GROUP_LABELS[key], sessions: byRecency.filter((s) => keyOf(s) === key) }))
    .filter((group) => group.sessions.length > 0);
}

/**
 * The one line of metadata under a row's title: agent, runner, how long ago, and "No node" for a
 * conversation whose node is gone (pressing it makes a new one).
 */
export function sessionMetaLine(
  session: CanvasSessionRecord,
  now: number,
  agentName?: string,
): string {
  const parts = agentName ? [agentName, session.runner] : [session.runner];
  parts.push(relativeAge(session.lastActivityAt, now));
  if (!session.nodeId) parts.push("No node");
  return parts.join(" · ");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeAge(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? "yesterday" : `${days}d`;
}

/**
 * The second line of a row: what the conversation was last asked.
 *
 * Empty for a row recorded before asks were kept, and for one nothing has been said to yet. The
 * caller draws nothing in that case rather than a placeholder — an empty line is honest, "no
 * messages yet" is noise repeated down the whole list.
 */
export function sessionPreviewLine(session: CanvasSessionRecord): string | null {
  const prompt = session.lastPrompt?.replace(/\s+/g, " ").trim();
  // Rows written while mouse reports were leaking into the ask buffer carry that residue as their
  // "prompt" (`session-activity.ts`). Showing it would be worse than showing nothing; the row heals
  // itself the next time the conversation is actually spoken to.
  if (!prompt || looksLikeEscapeResidue(prompt)) return null;
  return prompt;
}

/**
 * Filter the list by what someone typed into the panel's search box.
 *
 * Matches the title AND the last ask, because the thing a person remembers about a conversation is
 * as often a phrase from inside it as its name — and the name is derived from the first ask, which
 * may be nothing like the last one. Case- and accent-insensitive folding is deliberately not
 * attempted beyond `toLowerCase()`: this is a popover over a handful of rows, not a search engine.
 */
export function filterSessions(
  sessions: readonly CanvasSessionRecord[],
  query: string,
  agentName?: (session: CanvasSessionRecord) => string | undefined,
): CanvasSessionRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...sessions];
  return sessions.filter((session) => {
    const haystack =
      `${session.title} ${session.lastPrompt ?? ""} ${session.runner} ${agentName?.(session) ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * The title a row shows: the agent's handle and the session's own title, without repeating the
 * handle when the title already carries it.
 */
export function sessionRowTitle(session: CanvasSessionRecord, agentName?: string): string {
  const stored = session.title.trim();
  // A row named while mouse reports were leaking into the ask buffer carries that residue as its
  // title. `session-activity.ts` replaces it on the next real ask — but a list must not show
  // `<0;50;20M<0;50;20m…` in the meantime, so the reader falls back to what the conversation was
  // last asked, which is the name it is about to be given anyway.
  // A placeholder ("New conversation") says nothing a row's position does not; what was asked does.
  const usable = stored && !isPlaceholderTitle(stored) ? stored : sessionPreviewLine(session);
  const title = usable || "New conversation";
  if (!agentName) return title;
  return title.startsWith(`${agentName} ·`) || title === agentName ? title : `${agentName} · ${title}`;
}
