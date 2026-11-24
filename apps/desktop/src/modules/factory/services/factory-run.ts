import type { FactoryIntake, FactoryIntakeTurn, FactoryPrWatch, FactoryProgress, FactoryTicket, FactoryTriage, GraphRunStartInput } from "@/lib/tauri/graph-run";
import { graphRunSpend, type GraphRunRecord } from "@/modules/codecanvas/services/graph-run-record";

/**
 * A Factory Run seen from its ticket (ADR-0049 §1, F2b): one GitHub issue → one draft PR, run by the
 * Rust engine. The run is one step, {@link factoryNodeId}; its record is the truth, read again on
 * every `graph-run://changed`.
 */

/**
 * The single step of a ticket's Factory Run (worktree → implement → gate → draft PR). Named per
 * ticket: the engine lets a step id live in one run at a time, so a shared id let only one ticket run.
 */
export function factoryNodeId(repo: string, issue: FactoryRef): string {
  return factoryWorkflowId(repo, issue);
}

/** The run's one step, read from its record: runs made before {@link factoryNodeId} used `"factory"`. */
function stepOf(record: GraphRunRecord): string {
  return record.checkpoint.nodeIds[0] ?? "factory";
}

/**
 * What names a ticket: a GitHub issue number, or a Notion ticket id such as `TKT-123` (#168). The
 * repo is always the one the code is in.
 */
export type FactoryRef = number | string;

/** `#12`, or `TKT-123`. */
export const factoryRefLabel = (ref: FactoryRef) => (typeof ref === "number" ? `#${ref}` : ref);

/** The ticket's ref: its Notion id when it is a Notion ticket, else its issue number. */
export const factoryTicketRef = (ticket: Pick<FactoryTicket, "issue" | "notion">): FactoryRef => ticket.notion?.key ?? ticket.issue;

/** Sorts refs: issue numbers by value, then Notion ids by prefix and number. */
export function compareRefs(a: FactoryRef, b: FactoryRef): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Every run of one ticket carries this, so the newest one can be found again. */
export function factoryWorkflowId(repo: string, issue: FactoryRef): string {
  return `factory:${repo.toLowerCase()}#${issue}`;
}

/** The ticket's newest run, or null when it never ran. */
export function latestFactoryRun(records: readonly GraphRunRecord[], repo: string, issue: FactoryRef): GraphRunRecord | null {
  const id = factoryWorkflowId(repo, issue);
  return records
    .filter((r) => r.workflowId === id)
    .reduce<GraphRunRecord | null>((best, r) => (best === null || r.startedAt > best.startedAt ? r : best), null);
}

/**
 * `done` is a draft PR still open; `merged` and `pr-closed` are how it ended (#147).
 * `needs-answers` / `needs-approval`: the run waits for the user's intake decision (FI2).
 * `triage-blocked`: triage refused the ticket or found work on it already (FI3).
 */
export type FactoryRunState =
  | "idle"
  | "running"
  | "paused"
  | "recovery-required"
  | "needs-answers"
  | "needs-approval"
  | "triage-blocked"
  | "check-failed"
  | "error"
  | "done"
  | "merged"
  | "pr-closed"
  | "stopped";

/**
 * What stops a triaged run: duplicates first, then more than one sub-repo (nothing lifts that one),
 * then a refusal. Mirrors `Triage::blocked_by`.
 */
export function triageBlock(triage: FactoryTriage | null | undefined): "duplicates" | "multi-repo" | "refused" | null {
  if (!triage) return null;
  if (triage.duplicates.length > 0 && !triage.duplicatesAccepted) return "duplicates";
  if ((triage.report?.repos?.length ?? 0) > 1) return "multi-repo";
  if (triage.report?.verdict === "refuse" && !triage.refusalOverridden) return "refused";
  return null;
}

/** What the intake waits for, from its last turn. Mirrors `Intake::state` in the Rust crate. */
export function intakeWaitsFor(intake: FactoryIntake | null | undefined): "answers" | "approval" | "triage" | null {
  if (!intake || intake.approved) return null;
  const last: FactoryIntakeTurn | undefined = intake.turns[intake.turns.length - 1];
  if (last?.kind === "asked" && !last.answers) return "answers";
  if (last?.kind === "spec" && last.sentBack === undefined) return "approval";
  if (triageBlock(intake.triage)) return "triage";
  return null;
}

/** The turn the user must act on: the open questions or the spec to approve. */
export function openIntakeTurn(intake: FactoryIntake | null | undefined): FactoryIntakeTurn | null {
  const waits = intakeWaitsFor(intake);
  return waits === "answers" || waits === "approval" ? intake!.turns[intake!.turns.length - 1] : null;
}

const WAITING_STATE = { answers: "needs-answers", approval: "needs-approval", triage: "triage-blocked" } as const;

export interface FactoryRunView {
  state: FactoryRunState;
  /** The gate output of a failed Check, or why the run failed. */
  output: string | null;
  prUrl: string | null;
  spentUsd: number | null;
  capUsd: number | null;
  /** Stage, try and stage times; null with no run, or on a run saved before they were reported. */
  progress: FactoryProgress | null;
  /** The questions and spec so far; null before the spec agent first ran. */
  intake: FactoryIntake | null;
  /** The Chief of Staff's view of the run's PR (CoS 4); null before its first look. */
  prWatch: FactoryPrWatch | null;
  canStart: boolean;
  canRaiseCap: boolean;
  canAbort: boolean;
}

/** Whether the run's PR opened as a Draft, and why. Runs saved before Open PRs existed were all Drafts. */
export function factoryPrOpening(progress: FactoryProgress | null | undefined): { draft: boolean; reason: string | null } {
  const opened = progress?.prOpening;
  return { draft: opened?.draft ?? true, reason: opened?.reason ?? null };
}

/** `PR #12`, read from its URL; null when the URL does not name one. */
export function factoryPrLabel(prUrl: string | null): string | null {
  const number = prUrl?.match(/\/pull\/(\d+)/)?.[1];
  return number ? `PR #${number}` : null;
}

export function factoryRunView(record: GraphRunRecord | null): FactoryRunView {
  const base = { output: null, prUrl: null, spentUsd: null, capUsd: null, progress: null, intake: null, prWatch: null, canRaiseCap: false, canAbort: false };
  if (!record) return { ...base, state: "idle", canStart: true };
  const { checkpoint } = record;
  const spentUsd = graphRunSpend(checkpoint).costUsd;
  const capUsd = checkpoint.engine?.budgetCap ?? null;
  const intake = checkpoint.engine?.intake ?? null;
  const known = { ...base, spentUsd, capUsd, progress: checkpoint.engine?.progress ?? null, intake, prWatch: checkpoint.engine?.prWatch ?? null };
  if ((record.status === "paused" || record.status === "waiting" || record.status === "running") && checkpoint.engine?.recovery !== undefined) {
    return { ...known, state: "recovery-required", output: checkpoint.engine.recovery, canStart: false, canAbort: true };
  }
  switch (record.status) {
    case "running":
      return { ...known, state: "running", canStart: false, canAbort: true };
    case "paused":
      return { ...known, state: "paused", canStart: false, canRaiseCap: true, canAbort: true };
    case "waiting":
      return {
        ...known,
        state: WAITING_STATE[intakeWaitsFor(intake) ?? "approval"],
        canStart: false,
        canAbort: true,
      };
    case "completed": {
      const prUrl = checkpoint.completed[stepOf(record)]?.detail ?? null;
      const pr = checkpoint.engine?.pr;
      // A PR closed unmerged leaves the issue undone: it can be started again.
      if (pr === "closed") return { ...known, state: "pr-closed", prUrl, canStart: true };
      return { ...known, state: pr === "merged" ? "merged" : "done", prUrl, canStart: false };
    }
    case "cancelled":
      return { ...known, state: "stopped", canStart: true };
    case "error": {
      const detail = checkpoint.failedDetail?.[stepOf(record)];
      if (detail !== undefined) return { ...known, state: "check-failed", output: detail, canStart: true };
      return { ...known, state: "error", output: checkpoint.engine?.error ?? null, canStart: true };
    }
  }
}

/** Every Factory Run has a cap (FI0): the engine refuses one without. What a start uses when the user set none. */
export const DEFAULT_CAP_USD = 2;

export interface FactoryStartRequest {
  projectId: string;
  repo: string;
  /** `number` is a Notion id (`TKT-123`) for a Notion ticket, which then also has `notion`. */
  issue: { number: FactoryRef; title: string; body: string | null };
  /** The Notion page of a Notion ticket (#168). */
  notion?: { pageId: string; url: string };
  /** The gh account of the Ticket Source. */
  account: string;
  /** The user's checkout of `repo`. */
  checkout: string;
  /** The delegation preset id the implementer runs as. */
  implementer: string;
  /** USD; required — the engine refuses a Factory Run without a cap. */
  budgetCap: number;
  /** Why the issue's previous run stopped, for Try again. */
  previousFailure?: string;
  /** A meta-repo run: the Workspace folder (= `checkout`); triage picks the sub-repo. */
  workspace?: string;
  /** A meta-repo run: every connected source's gh account by `owner/name`; see `FactoryTicket.repoAccounts`. */
  repoAccounts?: Record<string, string>;
}

/** The `graph_run_start` arguments for a Factory Run. `base` is left empty: Rust uses the repo's default branch. */
export function factoryStartInput(req: FactoryStartRequest): GraphRunStartInput {
  const ref = req.issue.number;
  const factory: FactoryTicket = {
    repo: req.repo,
    issue: typeof ref === "number" ? ref : 0,
    title: req.issue.title,
    body: req.issue.body ?? "",
    account: req.account,
    checkout: req.checkout,
    base: "",
    implementer: req.implementer,
    ...(req.previousFailure ? { previousFailure: req.previousFailure } : {}),
    ...(req.workspace ? { workspace: req.workspace } : {}),
    ...(req.workspace && req.repoAccounts && Object.keys(req.repoAccounts).length > 0 ? { repoAccounts: req.repoAccounts } : {}),
    ...(typeof ref === "string" ? { notion: { key: ref, pageId: req.notion?.pageId ?? "", url: req.notion?.url ?? "" } } : {}),
  };
  const brief = typeof ref === "number" ? `${req.repo}#${ref}` : `${ref} (code in ${req.repo})`;
  return {
    projectId: req.projectId,
    graph: { nodeIds: [factoryNodeId(req.repo, ref)], deps: [] },
    workflowId: factoryWorkflowId(req.repo, ref),
    run: { title: `${req.issue.title} (${factoryRefLabel(ref)})`, brief: `Factory Run for ${brief}` },
    budgetCap: req.budgetCap,
    factory,
  };
}
