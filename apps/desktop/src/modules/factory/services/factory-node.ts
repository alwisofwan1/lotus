import { factoryRefLabel, type FactoryRef } from "./factory-run";
import { factoryRunDetail } from "./factory-run-detail";
import { factoryRunElapsedMs, formatElapsed, type FactoryGroupId, type FactoryRunRow } from "./factory-run-list";

/**
 * What a Factory node on a canvas says about one issue's run (#146). The node keeps the issue, not
 * the run: Try again makes a new run, and the node follows it. So `row` is the issue's newest run,
 * or null when there is none to show.
 */
export interface FactoryNodeView {
  title: string;
  sentence: string;
  /** `0:42 · $0.31`; empty when there is no run. */
  meta: string;
  group: FactoryGroupId | null;
  /** Only a run that waits for a person gets a button. */
  needsYou: boolean;
  /** That button's one verb: what the person does next (Answer, Approve, Try again…). */
  next: string;
}

/** The next step of a run that waits for a person, as the one verb its node shows. */
const NEXT_STEP: Partial<Record<FactoryRunRow["state"], string>> = {
  "needs-answers": "Answer",
  "needs-approval": "Approve",
  "triage-blocked": "Decide",
  paused: "Raise cap",
  "check-failed": "Try again",
  error: "Try again",
};

/** The one verb for a run that waits for a person; empty for a run that does not. */
export function factoryNextStep(row: FactoryRunRow): string {
  return row.group === "needs-you" ? (NEXT_STEP[row.state] ?? "Open") : "";
}

export const factoryIssueTitle = (issue: FactoryRef, title: string) => `${factoryRefLabel(issue)} ${title}`.trim();

export function factoryNodeView(
  row: FactoryRunRow | null,
  saved: { issue: FactoryRef; title: string },
  now: number,
  loading: boolean,
): FactoryNodeView {
  if (!row) {
    return {
      title: factoryIssueTitle(saved.issue, saved.title),
      sentence: loading ? "Reading…" : "No Factory run for this issue.",
      meta: "",
      group: null,
      needsYou: false,
      next: "",
    };
  }
  const cost = row.spentUsd !== null ? ` · $${row.spentUsd.toFixed(2)}` : "";
  return {
    title: factoryIssueTitle(row.issue, row.title),
    sentence: factoryRunDetail(row).sentence,
    meta: `${formatElapsed(factoryRunElapsedMs(row, now))}${cost}`,
    group: row.group,
    needsYou: row.group === "needs-you",
    next: factoryNextStep(row),
  };
}
