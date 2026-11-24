import type { FactoryProgressStep } from "@/lib/tauri/graph-run";
import { factoryPrLabel, factoryPrOpening } from "./factory-run";
import { factoryRunElapsedMs, type FactoryRunRow } from "./factory-run-list";

/**
 * A run as events, newest last (Planes round 6). Only what the record holds: step start and end, the
 * triage verdict, the intake turns and the outcome. Answering and approving have no timestamp of
 * their own, so they are words in a row's meta and never a time. Pure.
 */

/** done: ended; ok: the PR opened; bad: failed; wait: on you; live: running now; skipped: replaced. */
export type FactoryEventTone = "done" | "ok" | "bad" | "wait" | "live" | "skipped";

export interface FactoryEvent {
  key: string;
  /** The record's own timestamp; null where the record has none. */
  at: number | null;
  label: string;
  /** The line under the label: cost, or what the user did or must do. */
  meta: string | null;
  /** How long the step took, or has run so far; null for intake turns, which have no end. */
  span: string | null;
  tone: FactoryEventTone;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}


/** Null for a run saved before the runner reported steps: the caller falls back to the Steps list. */
export function factoryTimeline(row: FactoryRunRow, now: number): FactoryEvent[] | null {
  const steps = row.progress?.steps ?? [];
  if (steps.length === 0) return null;
  const events: FactoryEvent[] = [];
  const hasLater = (step: FactoryProgressStep) => steps.some((s) => s.stage === step.stage && s.attempt === step.attempt + 1);
  const lastCheck = [...steps].reverse().find((s) => s.stage === "checking");
  const intake = row.intake;
  const specTurns = intake?.turns ?? [];

  for (const [i, step] of steps.entries()) {
    const running = step.endedAt === undefined && row.state === "running";
    const key = `${step.stage}:${step.attempt}:${i}`;
    const span = formatSpan((step.endedAt ?? now) - step.startedAt);
    const meta = running ? "running" : step.costUsd !== undefined ? usd(step.costUsd) : null;
    const tone: FactoryEventTone = running ? "live" : "done";
    switch (step.stage) {
      case "worktree":
        events.push({ key, at: step.startedAt, label: "Worktree made", meta, span, tone });
        break;
      case "triage": {
        const verdict = intake?.triage?.report?.verdict;
        events.push({ key, at: step.startedAt, label: verdict ? `Triage · ${verdict}` : "Triage", meta, span, tone });
        break;
      }
      case "spec":
        // The turns say more than the step does, so they take its place once there are any.
        if (specTurns.length === 0) events.push({ key, at: step.startedAt, label: "Spec", meta, span, tone });
        break;
      case "building":
        events.push({ key, at: step.startedAt, label: `Build · try ${step.attempt}`, meta, span, tone });
        break;
      case "checking": {
        // "Failed" is claimed only where the record shows it: a later try exists, or the run stopped on it.
        const failed = hasLater(step) || (row.state === "check-failed" && step === lastCheck);
        events.push({
          key,
          at: step.startedAt,
          label: failed ? `Check · try ${step.attempt} failed` : `Check · try ${step.attempt}`,
          meta: failed && !hasLater(step) ? "retry limit reached · you decide" : failed ? "a later try exists" : meta,
          span,
          tone: failed ? "bad" : tone,
        });
        break;
      }
      case "review":
        events.push({ key, at: step.startedAt, label: "Review", meta, span, tone });
        break;
      case "push":
        events.push({ key, at: step.startedAt, label: "Pushed to the PR", meta, span, tone });
        break;
      case "draft-pr": {
        const pr = factoryPrLabel(row.prUrl);
        events.push({ key, at: step.startedAt, label: `${factoryPrOpening(row.progress).draft ? "Draft " : ""}${pr ?? "PR"} opened`, meta, span, tone: row.prUrl ? "ok" : tone });
        break;
      }
    }
  }

  const lastSpec = specTurns.map((t) => t.kind).lastIndexOf("spec");
  for (const [i, turn] of specTurns.entries()) {
    if (turn.kind === "asked") {
      const n = turn.questions.length;
      events.push({
        key: `asked:${i}`,
        at: turn.at,
        label: `Spec asked ${n} ${n === 1 ? "question" : "questions"}`,
        meta: turn.superseded ? "replaced by Brainstorm live" : turn.answers ? "you answered" : "needs your answers",
        span: null,
        tone: turn.superseded ? "skipped" : turn.answers ? "done" : "wait",
      });
    } else {
      const open = i === lastSpec && row.state === "needs-approval";
      events.push({
        key: `spec:${i}`,
        at: turn.at,
        label: turn.live ? "Spec written live" : "Spec written",
        meta: turn.sentBack ? "you sent it back" : open ? "needs your approval" : intake?.approved && i === lastSpec ? "you approved" : null,
        span: null,
        tone: open ? "wait" : "done",
      });
    }
  }
  return events.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

/**
 * The timeline's one-line header: how the run ended, or what it is doing, and in how long. "Issues"
 * are the failed events the timeline shows, so the count never says more than the rows do.
 */
export function factoryTimelineSummary(
  row: Pick<FactoryRunRow, "state" | "startedAt" | "endedAt">,
  events: readonly FactoryEvent[],
  now: number,
): { tone: FactoryEventTone; text: string } {
  const took = formatSpan(factoryRunElapsedMs(row, now));
  const issues = events.filter((e) => e.tone === "bad").length;
  const withIssues = issues === 0 ? "" : ` with ${issues} ${issues === 1 ? "issue" : "issues"}`;
  switch (row.state) {
    case "running":
      return { tone: "live", text: `Running for ${took}` };
    case "done":
    case "merged":
      return { tone: issues > 0 ? "wait" : "done", text: `Finished${withIssues} in ${took}` };
    case "check-failed":
    case "error":
      return { tone: "bad", text: issues > 0 ? `Stopped${withIssues} after ${took}` : `Stopped with an error after ${took}` };
    case "paused":
    case "recovery-required":
    case "needs-answers":
    case "needs-approval":
    case "triage-blocked":
      return { tone: "wait", text: "Waiting on you" };
    default:
      return { tone: "skipped", text: `Stopped after ${took}` };
  }
}
