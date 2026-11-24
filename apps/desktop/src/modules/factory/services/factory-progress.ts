import type { FactoryProgress, FactoryStage } from "@/lib/tauri/graph-run";
import type { FactoryRunState } from "./factory-run";

/**
 * A Factory Run's progress as the page shows it: one line ("Checking · try 1 of 2"), a seven-part
 * bar, and the list of stages that ran. Pure — the record says where the run is, this only words it.
 */

const STAGES: readonly { stage: FactoryStage; label: string; doing: string }[] = [
  { stage: "triage", label: "Triage", doing: "Triaging the ticket" },
  { stage: "worktree", label: "Worktree", doing: "Making the worktree" },
  { stage: "spec", label: "Spec", doing: "Writing the spec" },
  { stage: "building", label: "Build", doing: "Building" },
  { stage: "checking", label: "Check", doing: "Checking" },
  { stage: "review", label: "Review", doing: "Reviewing against the spec" },
  { stage: "draft-pr", label: "Draft PR", doing: "Opening the draft PR" },
];

/** A Revision Run (CoS 6) pushes to its PR where a first run opens one: the same last slot of the bar. */
const PUSH = { stage: "push" as const, label: "Push", doing: "Pushing the round to the PR" };

const meta = (stage: FactoryStage) => (stage === "push" ? PUSH : STAGES.find((s) => s.stage === stage)!);

/** Where `stage` sits on the seven-part bar. */
const barIndex = (stage: FactoryStage) => STAGES.findIndex((s) => s.stage === (stage === "push" ? "draft-pr" : stage));

/** Building and checking happen once per try, so only they count tries. */
const hasTries = (stage: FactoryStage) => stage === "building" || stage === "checking";

/**
 * A running run with no stage yet waits for a place: only 3 Factory Runs work at once (the engine's
 * `DEFAULT_MAX_PARALLEL`), and a run past it has no worktree until one ends.
 */
export const FACTORY_WAITING_LINE = "Waiting in line";
export const FACTORY_WAITING_SENTENCE = "Waiting in line. Up to 3 runs work at once, so it starts when one ends.";

export function factoryProgressLine(progress: FactoryProgress | null): string | null {
  if (!progress) return null;
  const { doing } = meta(progress.stage);
  return hasTries(progress.stage) ? `${doing} · try ${progress.attempt} of ${progress.maxAttempts}` : doing;
}

const NEEDS_YOU_STATES: ReadonlySet<FactoryRunState> = new Set([
  "paused",
  "recovery-required",
  "needs-answers",
  "needs-approval",
  "triage-blocked",
  "check-failed",
  "error",
]);

/** `failed`: the step the run stopped on because it failed (a check out of tries, an engine error). */
export type FactoryStageStatus = "done" | "active" | "needs-you" | "failed" | "todo";

export interface FactoryStageSegment {
  stage: FactoryStage;
  label: string;
  status: FactoryStageStatus;
}

const FAILED_STATES: ReadonlySet<FactoryRunState> = new Set(["check-failed", "error"]);

/**
 * The stages, each done, going, waiting on you, failed, or not reached. A failed run still waits on
 * you (it is in Needs you); its stage says failed so the strip names the step that broke.
 */
export function factoryStageBar(progress: FactoryProgress | null, state: FactoryRunState): FactoryStageSegment[] {
  const current = progress ? barIndex(progress.stage) : -1;
  const atCurrent: FactoryStageStatus =
    state === "running" ? "active" : FAILED_STATES.has(state) ? "failed" : NEEDS_YOU_STATES.has(state) ? "needs-you" : "todo";
  return STAGES.map(({ stage, label }, i) => {
    // Every stage was reached once the draft PR opened, however the PR ended after.
    if (state === "done" || state === "merged" || state === "pr-closed") return { stage, label, status: "done" };
    const status: FactoryStageStatus = i < current ? "done" : i === current ? atCurrent : "todo";
    return { stage, label, status };
  });
}

export interface FactoryTries {
  /** One per allowed try, in order. */
  cells: FactoryStageStatus[];
  /** "try 2 of 2". */
  label: string;
}

/**
 * Build and check repeat once per try. Null until the run reaches Build, and for a run allowed only
 * one try, where there is nothing to count. A try before the current one failed: only a failed check
 * starts another. The current try takes the strip's status for the stage it is on; past Check it
 * passed.
 */
export function factoryTries(progress: FactoryProgress | null, state: FactoryRunState): FactoryTries | null {
  if (!progress || progress.maxAttempts < 2) return null;
  const at = barIndex(progress.stage);
  if (at < barIndex("building")) return null;
  const now = factoryStageBar(progress, state)[at].status;
  const current: FactoryStageStatus = hasTries(progress.stage) ? now : "done";
  const cells = Array.from({ length: progress.maxAttempts }, (_, i): FactoryStageStatus => {
    const n = i + 1;
    return n < progress.attempt ? "failed" : n === progress.attempt ? current : "todo";
  });
  return { cells, label: `try ${progress.attempt} of ${progress.maxAttempts}` };
}

export interface FactoryStepRow {
  label: string;
  /** Null for a stage that has no tries. */
  attempt: number | null;
  durationMs: number;
  costUsd: number | null;
  running: boolean;
}

/** Each stage that ran, in order; a running one counts up to `now`. */
export function factoryStepRows(progress: FactoryProgress | null, now: number): FactoryStepRow[] {
  return (progress?.steps ?? []).map((step) => ({
    label: meta(step.stage).label,
    attempt: hasTries(step.stage) ? step.attempt : null,
    durationMs: Math.max(0, (step.endedAt ?? now) - step.startedAt),
    costUsd: step.costUsd ?? null,
    running: step.endedAt === undefined,
  }));
}
