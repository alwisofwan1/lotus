import type { FactoryChiefLog, FactoryIntake, FactoryProgress, FactoryPrWatch, FactoryTicket } from "@/lib/tauri/graph-run";
import type { GraphRunRecord } from "@/modules/codecanvas/services/graph-run-record";
import { factoryRunView, factoryTicketRef, factoryWorkflowId, type FactoryRef, type FactoryRunState } from "./factory-run";

/**
 * Every Factory Run, as the Factory page lists it: one row per issue, sorted into the four groups a
 * person acts on. Pure — the hook feeds it records, the page paints rows.
 */

/** Where a run sits for the person: waiting on them, still going, ready to look at, or stopped. */
export type FactoryGroupId = "needs-you" | "working" | "ready" | "done" | "stopped";

const GROUP_ORDER: readonly { id: FactoryGroupId; label: string }[] = [
  { id: "needs-you", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "ready", label: "Ready to review" },
  { id: "done", label: "Done" },
  { id: "stopped", label: "Stopped" },
];

const GROUP_OF_STATE: Record<FactoryRunState, FactoryGroupId> = {
  idle: "stopped",
  running: "working",
  paused: "needs-you",
  "recovery-required": "needs-you",
  "needs-answers": "needs-you",
  "needs-approval": "needs-you",
  "triage-blocked": "needs-you",
  "check-failed": "needs-you",
  error: "needs-you",
  done: "ready",
  merged: "done",
  // Closed without a merge: the work did not land, so it is not Done.
  "pr-closed": "stopped",
  stopped: "stopped",
};

/** The group a run in `state` belongs to; the same everywhere a run is shown. */
export function factoryGroupOf(state: FactoryRunState): FactoryGroupId {
  return GROUP_OF_STATE[state];
}

export interface FactoryRunRow {
  /** The run's id (not the issue's). */
  id: string;
  projectId: string;
  repo: string;
  /** The issue number, or the Notion ticket id (#168). */
  issue: FactoryRef;
  title: string;
  state: FactoryRunState;
  group: FactoryGroupId;
  startedAt: number;
  endedAt: number | null;
  spentUsd: number | null;
  capUsd: number | null;
  prUrl: string | null;
  /** The gate output of a failed check, or why the run failed. */
  output: string | null;
  /** The ticket the run was started with: enough to start it again. */
  ticket: FactoryTicket;
  /** Stage, try and stage times; null on a run saved before the runner reported them. */
  progress: FactoryProgress | null;
  /** The questions and spec so far; null before the spec agent first ran. */
  intake: FactoryIntake | null;
  /** The Chief of Staff's notes on the run; null until it first noted something (ADR-0056). */
  chief?: FactoryChiefLog | null;
  /** The run's PR as the Chief of Staff last saw it; null before its first look (CoS 4). */
  prWatch?: FactoryPrWatch | null;
}

export interface FactoryRunGroup {
  id: FactoryGroupId;
  label: string;
  rows: FactoryRunRow[];
}

/**
 * A Revision Run (CoS 6) shows on its PR's card ("Round 2 of 3"), not as a card of its own: one card
 * per Factory PR. Only a round that waits on the user in a way the PR cannot show gets its own row
 * (paused at its cap, or held for recovery), so Raise cap and Inspect stay one click away.
 */
const ROUND_ROW_STATES: ReadonlySet<FactoryRunState> = new Set(["paused", "recovery-required"]);

/** One row per issue — its newest run. Records that are not Factory Runs are left out. */
export function factoryRunRows(records: readonly GraphRunRecord[]): FactoryRunRow[] {
  const newest = new Map<string, GraphRunRecord>();
  for (const record of records) {
    const ticket = record.checkpoint.engine?.factory;
    if (!ticket) continue;
    if (ticket.revision && !ROUND_ROW_STATES.has(factoryRunView(record).state)) continue;
    // A round's row is its own, so it never takes the place of its PR's card.
    const key = factoryRowKey({ id: record.id, repo: ticket.repo, issue: factoryTicketRef(ticket), ticket });
    const best = newest.get(key);
    if (best === undefined || record.startedAt > best.startedAt) newest.set(key, record);
  }
  return [...newest.values()].map((record) => {
    const ticket = record.checkpoint.engine!.factory!;
    const view = factoryRunView(record);
    return {
      id: record.id,
      projectId: record.projectId,
      repo: ticket.repo,
      issue: factoryTicketRef(ticket),
      title: ticket.title,
      state: view.state,
      group: GROUP_OF_STATE[view.state],
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      spentUsd: view.spentUsd,
      capUsd: view.capUsd,
      prUrl: view.prUrl,
      output: view.output,
      ticket,
      progress: view.progress,
      intake: view.intake,
      chief: record.checkpoint.engine?.chief ?? null,
      prWatch: record.checkpoint.engine?.prWatch ?? null,
    };
  });
}

/** The key a row is opened by: its issue, or for a round's own row, the round's run. */
export function factoryRowKey(row: Pick<FactoryRunRow, "id" | "repo" | "issue" | "ticket">): string {
  const issue = factoryWorkflowId(row.repo, row.issue);
  return row.ticket.revision ? `${issue}:round:${row.id}` : issue;
}

/** The rows in their groups, newest first; a group with no row is left out. */
export function groupFactoryRuns(rows: readonly FactoryRunRow[]): FactoryRunGroup[] {
  return GROUP_ORDER.map(({ id, label }) => ({
    id,
    label,
    rows: rows.filter((row) => row.group === id).sort((a, b) => b.startedAt - a.startedAt),
  })).filter((group) => group.rows.length > 0);
}

/** Each repo with runs and how many, by name; what the Runs and Board repo filter offers (#167). */
export function factoryRepoCounts(rows: readonly FactoryRunRow[]): { repo: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.repo, (counts.get(row.repo) ?? 0) + 1);
  return [...counts].map(([repo, count]) => ({ repo, count })).sort((a, b) => a.repo.localeCompare(b.repo));
}

/** What the sidebar badge counts: only the runs that wait for a person. */
export function needsYouCount(rows: readonly FactoryRunRow[]): number {
  return rows.filter((row) => row.group === "needs-you").length;
}

/** A finished run counts start to end; a live one counts to `now`. */
export function factoryRunElapsedMs(row: Pick<FactoryRunRow, "startedAt" | "endedAt">, now: number): number {
  return Math.max(0, (row.endedAt ?? now) - row.startedAt);
}

/** `6:12`, or `1:02:05` past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
