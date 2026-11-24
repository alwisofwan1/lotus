import type { FactoryChiefEntry, FactoryChiefSignal, FactoryFeedbackItem, FactoryProgress } from "@/lib/tauri/graph-run";
import { factoryMaxRounds, factoryPrChip } from "./factory-board";
import { factoryRowKey, type FactoryRunRow } from "./factory-run-list";

/**
 * The Chief of Staff pane (ADR-0056, "Chief of Staff UI"): one inbox of what needs the user, read
 * from the notes the Rust watcher keeps on each run. Pure — the page paints what these return.
 *
 * An item shows while its signal is raised AND its condition still holds on the record, so a note
 * the watcher has not cleared yet (it looks once a minute) never offers a stale action.
 */

/** What the user may do about an item. Each one is a click; the Chief of Staff only proposes. */
export type FactoryChiefAction = "raise-cap" | "abort" | "open-run" | "open-worktree" | "start-round";

export interface FactoryChiefItem {
  /** `factoryRowKey(row)`: the same key the run detail opens by. */
  key: string;
  row: FactoryRunRow;
  signal: FactoryChiefSignal;
  /** The note that raised it: why, in the user's words. */
  reason: string;
  /** When it was raised (Unix ms). */
  at: number;
  actions: FactoryChiefAction[];
}

export interface FactoryChiefInbox {
  /** Needs the user, newest first. */
  needsYou: FactoryChiefItem[];
  /** Watched, nothing to do: runs still going. */
  watching: FactoryRunRow[];
}

/** Raise cap only works on a paused run, so the 80% warning offers Open run instead. A run that
 * needs recovery offers no Try again until it is aborted (factory AGENTS.md: no replacement start
 * before inspection; decided 2026-10-13). */
const ACTIONS: Record<FactoryChiefSignal, FactoryChiefAction[]> = {
  "waiting-on-you": ["open-run", "abort"],
  "paused-at-cap": ["raise-cap", "abort"],
  stalled: ["open-worktree", "abort"],
  "recovery-required": ["open-worktree", "abort"],
  "budget-burn": ["open-run", "abort"],
  // The batch itself is the item: its labels are edited in place, then a round works on it (CoS 6).
  feedback: ["start-round", "open-run"],
};

const WAITING = new Set(["needs-answers", "needs-approval", "triage-blocked"]);

/** When the run last showed life: a stage began or ended, or an agent took a step. */
function lastActivity(progress: FactoryProgress | null): number {
  const steps = progress?.steps.map((s) => s.endedAt ?? s.startedAt) ?? [];
  return Math.max(0, ...steps, progress?.lastOutput?.at ?? 0);
}

/** Whether the record still shows what the signal says, raised at `at`. */
function holds(signal: FactoryChiefSignal, row: FactoryRunRow, at: number): boolean {
  switch (signal) {
    case "waiting-on-you":
      return WAITING.has(row.state);
    case "paused-at-cap":
      return row.state === "paused";
    case "stalled":
      // A step since the watcher looked: working again, before its next look clears it.
      return row.state === "running" && lastActivity(row.progress) <= at;
    case "recovery-required":
      return row.state === "recovery-required";
    case "budget-burn":
      return row.state === "running" || WAITING.has(row.state);
    case "feedback":
      // Mirrors `waits_on_you`: feedback to decide, or a reply draft to send (CoS 9).
      return factoryFeedbackNeedingYou(row).length > 0 || factoryReplyDrafts(row).length > 0;
  }
}

/** Never sent to a round yet, or a round declined it or did not address it. Mirrors `waits_for_you`. */
const WAITS_FOR_YOU: ReadonlySet<FactoryFeedbackItem["status"]> = new Set(["needs-you", "not-addressed", "declined"]);

/** The labels a round works on. Mirrors `ROUND_LABELS`. */
const ROUND_LABELS: ReadonlySet<string> = new Set(["change", "nit"]);

/**
 * Why Start round cannot run now, or null when it can. Mirrors `round_items` in the Rust crate, which
 * checks again: this only keeps a button from offering what would be refused.
 */
export function factoryRoundBlocked(row: FactoryRunRow): string | null {
  const watch = row.prWatch;
  if (row.ticket.revision || row.state !== "done" || !watch) return "No open Factory PR.";
  const running = watch.rounds?.find((r) => !r.ended);
  if (running) return `Round ${running.round} is still running.`;
  const max = factoryMaxRounds(watch);
  if ((watch.rounds?.length ?? 0) >= max) return `The PR had all its ${max} rounds.`;
  const ready = factoryFeedbackNeedingYou(row).some((i) => i.counts && factoryGoesToRound(i));
  return ready ? null : "No change, nit or accepted spec change waits for a round. Set a label first.";
}

/** A sure change or nit, or a spec change the user accepted. Mirrors `goes_to_round`. */
export function factoryGoesToRound(item: FactoryFeedbackItem): boolean {
  if (item.unsure || !item.label) return false;
  return item.label === "spec-change" ? item.amendment !== undefined : ROUND_LABELS.has(item.label);
}

/** A spec change the user has not decided yet: it offers Accept and Decline (CoS 8). */
export function factorySpecChangeOpen(item: FactoryFeedbackItem): boolean {
  return item.counts && item.label === "spec-change" && !item.unsure && item.amendment === undefined && WAITS_FOR_YOU.has(item.status);
}

/** The criteria Accept proposes, one per line, for the user to edit: the comment itself, on one line. */
export function factoryProposedCriteria(item: FactoryFeedbackItem): string {
  return item.body.replace(/\s+/g, " ").trim();
}

/** Typed criteria, one per line; blank lines dropped. Lotus numbers them. */
export function factoryCriteriaLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The criteria an accepted spec change added: "Amendment 1: AC-2, AC-3". */
export function factoryAmendmentLine(row: FactoryRunRow, item: FactoryFeedbackItem): string | null {
  const amendment = row.intake?.amendments?.find((a) => a.n === item.amendment);
  if (!amendment) return null;
  return `Amendment ${amendment.n}: ${amendment.criteria.map((c) => c.split(":")[0]).join(", ")}`;
}

/** One reply draft, round summary or Slack thread reply that waits for Send (CoS 9, CoS 12). */
export interface FactoryReplyDraft {
  /** An item id, `summary:<round>` or `slack:<round>`. What Send and the edit name. */
  key: string;
  /** "To rev · src/a.rs:3 · addressed", "Round 1 summary · on the PR", or "Round 1 · Slack thread in #reviews · mentions @rev". */
  meta: string;
  text: string;
  /** A Slack reply's reviewers with no Slack member ID yet: the user is asked who they are. */
  unknownPeople?: string[];
}

const DRAFT_STATUS: Partial<Record<FactoryFeedbackItem["status"], string>> = {
  addressed: "addressed",
  "not-addressed": "not done yet",
  declined: "declined",
  "out-of-scope": "out of scope",
  "needs-you": "your answer",
};

/** The drafts not sent yet, replies first, then round summaries. None once the PR ended. Mirrors `unsent`. */
export function factoryReplyDrafts(row: Pick<FactoryRunRow, "prWatch">): FactoryReplyDraft[] {
  const watch = row.prWatch;
  if (!watch || watch.phase === "merged" || watch.phase === "closed") return [];
  const replies = (watch.feedback ?? [])
    .filter((item) => item.counts && item.source !== "check" && item.replySent === undefined && item.reply?.trim())
    .map((item) => ({ key: item.id, meta: [`To ${item.author}`, factoryFeedbackPlace(item), DRAFT_STATUS[item.status]].filter(Boolean).join(" · "), text: item.reply! }));
  const summaries = (watch.rounds ?? [])
    .filter((round) => round.summarySent === undefined && round.summary?.trim())
    .map((round) => ({ key: `summary:${round.round}`, meta: `Round ${round.round} summary · on the PR`, text: round.summary! }));
  const slack = (watch.rounds ?? []).flatMap((round) => {
    const reply = round.slack;
    if (!reply || reply.sent !== undefined || !reply.text.trim()) return [];
    const people = reply.mention ?? [];
    const known = people.filter((m) => m.slack).map((m) => `@${m.github}`);
    const mentions = known.length > 0 ? `mentions ${known.join(", ")}` : "mentions no one yet";
    const unknownPeople = people.filter((m) => !m.slack).map((m) => m.github);
    return [{ key: `slack:${round.round}`, meta: `Round ${round.round} · Slack thread in #${reply.thread.channelName} · ${mentions}`, text: reply.text, unknownPeople }];
  });
  return [...replies, ...summaries, ...slack];
}

/**
 * The PR line on the source ticket's Factory card in Tasks (CoS 10): "PR #9 · Round 1 of 3 ·
 * waiting for review · 2 need you · 3 replies to send". Null when the Chief of Staff watches no
 * open PR for the run (merged and closed say so in the card's own status).
 */
export function factoryCardPrLine(view: Pick<FactoryRunRow, "state" | "prWatch">): string | null {
  const chip = factoryPrChip(view);
  if (!chip || !view.prWatch) return null;
  const parts = [`PR #${view.prWatch.number}`, chip];
  const needYou = factoryFeedbackNeedingYou(view).length;
  if (needYou > 0) parts.push(`${needYou} need${needYou === 1 ? "s" : ""} you`);
  const drafts = factoryReplyDrafts(view).length;
  if (drafts > 0) parts.push(`${drafts} repl${drafts === 1 ? "y" : "ies"} to send`);
  return parts.join(" · ");
}

/** A question the user may answer: the Judge cannot read the code, so it never drafts one (CoS 9). */
export function factoryAnswerable(item: FactoryFeedbackItem): boolean {
  return item.counts && item.label === "question" && !item.unsure && WAITS_FOR_YOU.has(item.status) && !item.reply?.trim();
}

/** The PR's Feedback Items that wait for the user, by batch then age. None once the PR ended. */
export function factoryFeedbackNeedingYou(row: Pick<FactoryRunRow, "prWatch">): FactoryFeedbackItem[] {
  const watch = row.prWatch;
  if (!watch || watch.phase === "merged" || watch.phase === "closed") return [];
  return (watch.feedback ?? []).filter((item) => WAITS_FOR_YOU.has(item.status)).sort((a, b) => (a.batch ?? 0) - (b.batch ?? 0) || a.at - b.at);
}

/** Said by someone who is not a reviewer, the author or a writer: shown, never acted on. */
export function factoryFeedbackNotCounted(row: FactoryRunRow): FactoryFeedbackItem[] {
  return (row.prWatch?.feedback ?? []).filter((item) => !item.counts);
}

/** "src/a.rs:3" for a line comment, the check's name for CI, else the kind of comment. */
export function factoryFeedbackPlace(item: FactoryFeedbackItem): string {
  if (item.path) return item.line ? `${item.path}:${item.line}` : item.path;
  switch (item.source) {
    case "review":
      return "review";
    case "check":
      return "CI";
    default:
      return "comment";
  }
}

const keyOf = factoryRowKey;

/** The newest note that raised `signal` on the run. */
function raisedBy(row: FactoryRunRow, signal: FactoryChiefSignal): FactoryChiefEntry | null {
  const log = row.chief?.log ?? [];
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i].signal === signal && log[i].raised) return log[i];
  }
  return null;
}

export function factoryChiefItems(rows: readonly FactoryRunRow[]): FactoryChiefItem[] {
  const items: FactoryChiefItem[] = [];
  for (const row of rows) {
    for (const signal of row.chief?.open ?? []) {
      const entry = raisedBy(row, signal);
      if (!entry || !holds(signal, row, entry.at)) continue;
      items.push({ key: keyOf(row), row, signal, reason: entry.text, at: entry.at, actions: ACTIONS[signal] });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}

/** The run's PR is open and the Chief of Staff watches it (CoS 4). */
function prInReview(row: FactoryRunRow): boolean {
  return factoryPrChip(row) !== null;
}

/** How many Factory PRs are open and watched: the strip's "N PRs in review". */
export function factoryPrsInReview(rows: readonly FactoryRunRow[]): number {
  return rows.filter(prInReview).length;
}

export function factoryChiefInbox(rows: readonly FactoryRunRow[]): FactoryChiefInbox {
  const needsYou = factoryChiefItems(rows);
  const flagged = new Set(needsYou.map((item) => item.row.id));
  const watching = rows
    .filter((row) => (row.group === "working" || prInReview(row)) && !flagged.has(row.id))
    .sort((a, b) => b.startedAt - a.startedAt);
  return { needsYou, watching };
}

/** "2 need you · 4 PRs in review · checked 3 min ago". `checkedAt` null = it has not looked yet. */
export function factoryChiefStripLine(needsYou: number, checkedAt: number | null, now: number, prsInReview = 0): string {
  const need = needsYou === 0 ? "Nothing needs you" : `${needsYou} need${needsYou === 1 ? "s" : ""} you`;
  const prs = prsInReview === 0 ? [] : [`${prsInReview} PR${prsInReview === 1 ? "" : "s"} in review`];
  return [need, ...prs, checkedLine(checkedAt, now)].join(" · ");
}

function checkedLine(checkedAt: number | null, now: number): string {
  if (checkedAt === null) return "not checked yet";
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000);
  if (minutes === 0) return "checked just now";
  if (minutes < 60) return `checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `checked ${hours} h ago`;
}

/** The run's notes, newest first: the log under the selected item. */
export function factoryChiefLog(row: FactoryRunRow): FactoryChiefEntry[] {
  return [...(row.chief?.log ?? [])].sort((a, b) => b.at - a.at);
}

export const FACTORY_CHIEF_ACTION_LABEL: Record<FactoryChiefAction, string> = {
  "raise-cap": "Raise cap",
  abort: "Abort",
  "open-run": "Open run",
  "open-worktree": "Open worktree",
  "start-round": "Start round",
};

export const FACTORY_FEEDBACK_LABEL_TEXT: Record<NonNullable<FactoryFeedbackItem["label"]>, string> = {
  change: "Change",
  nit: "Nit",
  question: "Question",
  "spec-change": "Spec change",
  none: "Nothing to do",
};
