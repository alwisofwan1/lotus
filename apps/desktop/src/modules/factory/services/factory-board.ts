import { DEFAULT_MAX_ROUNDS } from "@/lib/tauri/graph-run";
import type { FactoryPrWatch, FactoryRevisionRound } from "@/lib/tauri/graph-run";
import { FACTORY_WAITING_LINE, factoryProgressLine } from "./factory-progress";
import type { FactoryRunRow } from "./factory-run-list";
import { factoryPrLabel, factoryPrOpening, factoryRefLabel, triageBlock, type FactoryRef } from "./factory-run";

/**
 * The Board tab: each run as a card in the column of where it is now. Pure — a new read of the
 * records moves a card by itself, because its column is worked out again from its state and stage.
 */

export type FactoryColumnId = "queued" | "building" | "checking" | "needs-you" | "ready" | "done";

const COLUMNS: readonly { id: FactoryColumnId; label: string }[] = [
  { id: "needs-you", label: "Needs you" },
  { id: "queued", label: "Queued" },
  { id: "building", label: "Building" },
  { id: "checking", label: "Checking" },
  { id: "ready", label: "Ready to review" },
  { id: "done", label: "Done" },
];

export interface FactoryBoardColumn {
  id: FactoryColumnId;
  label: string;
  rows: FactoryRunRow[];
}

/**
 * Where a run's card goes; null for a stopped run, which is not on the board. Opening the draft PR
 * is the last moment of the check, so it stays in Checking until the run is done.
 */
export function factoryBoardColumn(row: FactoryRunRow): FactoryColumnId | null {
  if (row.group === "needs-you") return "needs-you";
  if (row.group === "ready") return "ready";
  if (row.group === "done") return "done";
  if (row.group !== "working") return null;
  switch (row.progress?.stage) {
    case "triage":
    case "spec":
    case "building":
      return "building";
    case "checking":
    case "review":
    case "draft-pr":
      return "checking";
    default:
      return "queued";
  }
}

/** The six columns, always all of them, Needs you first, newest card first. */
export function factoryBoardColumns(rows: readonly FactoryRunRow[]): FactoryBoardColumn[] {
  return COLUMNS.map(({ id, label }) => ({
    id,
    label,
    rows: rows.filter((row) => factoryBoardColumn(row) === id).sort((a, b) => b.startedAt - a.startedAt),
  }));
}

/** The card's one line: where a working run is, or why it stopped where it is. */
export function factoryCardLine(row: FactoryRunRow): string {
  switch (row.state) {
    case "running":
      return factoryProgressLine(row.progress) ?? FACTORY_WAITING_LINE;
    case "paused":
      return "Paused at the cost cap";
    case "recovery-required":
      return "Recovery inspection required";
    case "needs-answers":
      return "Questions for you";
    case "needs-approval":
      return "Spec ready to approve";
    case "triage-blocked":
      switch (triageBlock(row.intake?.triage)) {
        case "duplicates":
          return "Work on this issue already exists";
        case "multi-repo":
          return "Needs more than one sub-repo";
        default:
          return "Triage advises not to build it";
      }
    case "check-failed":
      return "The check failed";
    case "error":
      return "Stopped with an error";
    case "done":
      return row.prUrl ? (factoryPrOpening(row.progress).draft ? "Draft PR open" : "PR open") : "Done";
    case "merged":
      return `${factoryPrLabel(row.prUrl) ?? "PR"} merged`;
    case "pr-closed":
      return `${factoryPrLabel(row.prUrl) ?? "PR"} closed without a merge`;
    default:
      return "Stopped";
  }
}

/** The repo's `max_rounds` as the last round saw it; the default before the first round. */
export function factoryMaxRounds(watch: Pick<FactoryPrWatch, "maxRounds">): number {
  return watch.maxRounds ?? DEFAULT_MAX_ROUNDS;
}

/**
 * The chip on the card of a run whose PR is open, as the Chief of Staff last saw it: "in review",
 * "Round 2 of 3", "Round 2 of 3 · waiting for review". One card per Factory PR; its rounds show
 * here, not as cards (CoS 6). Null when the PR is not watched or has ended (the card line says
 * merged or closed).
 */
export function factoryPrChip(row: Pick<FactoryRunRow, "state" | "prWatch">): string | null {
  const watch = row.prWatch;
  if (row.state !== "done" || !watch) return null;
  const rounds = watch.rounds ?? [];
  const round = rounds.length > 0 ? `Round ${rounds.length} of ${factoryMaxRounds(watch)}` : null;
  switch (watch.phase) {
    case "in-review":
      return round ? `${round} · in review` : "in review";
    case "revising":
      return round ?? "revising";
    case "waiting-for-review":
      return round ? `${round} · waiting for review` : "waiting for review";
    case "needs-you":
      return round ? `${round} · needs you` : "needs you";
    case "out-of-rounds":
      return "Out of rounds";
    default:
      return null;
  }
}

export interface FactoryRoundLine {
  round: number;
  runId: string;
  /** "Running", "Pushed", "Needs you". */
  state: string;
  /** "2 items · Round 2 pushed 1a2b3c4d to …", or why it needs you. */
  line: string;
  tone: "running" | "ok" | "bad";
}

/** The PR's rounds for its detail, oldest first. */
export function factoryRoundLines(rounds: readonly FactoryRevisionRound[] | undefined): FactoryRoundLine[] {
  return (rounds ?? []).map((r) => {
    const items = `${r.items.length} ${r.items.length === 1 ? "item" : "items"}`;
    const line = r.note ? `${items} · ${r.note}` : items;
    if (!r.ended) return { round: r.round, runId: r.runId, state: "Running", line, tone: "running" };
    if (r.ended === "pushed") return { round: r.round, runId: r.runId, state: "Pushed", line, tone: "ok" };
    return { round: r.round, runId: r.runId, state: "Needs you", line, tone: "bad" };
  });
}

/** The verb on a Needs-you row; it opens the run, where the decision itself is made. */
export function factoryRowAction(state: FactoryRunRow["state"]): string | null {
  switch (state) {
    case "needs-answers":
      return "Answer";
    case "needs-approval":
      return "Review spec";
    case "triage-blocked":
      return "Decide";
    case "paused":
      return "Raise cap";
    case "check-failed":
    case "error":
      return "See why";
    case "recovery-required":
      return "Inspect";
    default:
      return null;
  }
}

/** The runs waiting on the user's intake decision (FI2, FI3), as Inbox lists them; newest first. */
export function factoryIntakeWaiting(rows: readonly FactoryRunRow[]): { id: string; repo: string; issue: FactoryRef; title: string; line: string }[] {
  return rows
    .filter((row) => row.state === "needs-answers" || row.state === "needs-approval" || row.state === "triage-blocked")
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((row) => ({ id: row.id, repo: row.repo, issue: row.issue, title: `${factoryRefLabel(row.issue)} ${row.title}`, line: factoryCardLine(row) }));
}
