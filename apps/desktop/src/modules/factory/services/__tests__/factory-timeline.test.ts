import { describe, expect, it } from "vitest";
import { factoryTimeline, factoryTimelineSummary } from "../factory-timeline";
import type { FactoryRunRow } from "../factory-run-list";

const base = {
  id: "r", projectId: "p", repo: "o/r", issue: 1, title: "t", state: "needs-answers", group: "needs-you", startedAt: 0, endedAt: null,
  spentUsd: null, capUsd: null, prUrl: null, output: null, intake: null, progress: null,
  ticket: { repo: "o/r", issue: 1, title: "t", body: "", account: "a", checkout: "/c", base: "main", implementer: "p" },
} as unknown as FactoryRunRow;

const q = { question: "?", choices: ["a", "b"], recommended: "a", why: "" };
const steps = [
  { stage: "worktree" as const, attempt: 1, startedAt: 1000, endedAt: 4000 },
  { stage: "triage" as const, attempt: 1, startedAt: 4000, endedAt: 45_000, costUsd: 0.06 },
  { stage: "spec" as const, attempt: 1, startedAt: 45_000 },
];

describe("factoryTimeline", () => {
  it("is null for a run with no recorded steps", () => {
    expect(factoryTimeline(base, 0)).toBeNull();
  });

  it("ends on what the run waits for, from the intake turn, with no time for the answer", () => {
    const row = {
      ...base,
      progress: { stage: "spec", attempt: 1, maxAttempts: 2, steps },
      intake: { turns: [{ kind: "asked", questions: [q, q, q], at: 46_000 }], approved: false, triage: { report: { verdict: "go" }, duplicates: [], labels: [], notes: [], duplicatesAccepted: false, refusalOverridden: false, at: 4000 } },
    } as unknown as FactoryRunRow;
    const events = factoryTimeline(row, 50_000)!;
    expect(events.map((e) => e.label)).toEqual(["Worktree made", "Triage · go", "Spec asked 3 questions"]);
    expect(events[1]).toMatchObject({ meta: "$0.06", span: "41s", tone: "done" });
    expect(events[2]).toMatchObject({ meta: "needs your answers", span: null, tone: "wait" });
  });

  it("says it only when answered, and never invents a time for approving", () => {
    const row = {
      ...base,
      state: "running",
      progress: { stage: "spec", attempt: 1, maxAttempts: 2, steps },
      intake: { turns: [{ kind: "asked", questions: [q], answers: [{ note: "x" }], at: 46_000 }, { kind: "spec", markdown: "m", live: false, at: 60_000 }], approved: true },
    } as unknown as FactoryRunRow;
    const events = factoryTimeline(row, 70_000)!;
    expect(events.at(-2)).toMatchObject({ label: "Spec asked 1 question", meta: "you answered" });
    expect(events.at(-1)).toMatchObject({ label: "Spec written", meta: "you approved", at: 60_000 });
  });

  it("marks a question turn Brainstorm live replaced as skipped", () => {
    const row = {
      ...base,
      progress: { stage: "spec", attempt: 1, maxAttempts: 2, steps },
      intake: { turns: [{ kind: "asked", questions: [q], superseded: true, at: 46_000 }], approved: false },
    } as unknown as FactoryRunRow;
    expect(factoryTimeline(row, 50_000)!.at(-1)).toMatchObject({ meta: "replaced by Brainstorm live", tone: "skipped" });
  });
});

describe("factoryTimelineSummary", () => {
  const bad = { key: "c", at: 0, label: "Check · try 1 failed", meta: null, span: "3s", tone: "bad" as const };
  const ok = { key: "w", at: 0, label: "Worktree made", meta: null, span: "3s", tone: "done" as const };

  it("says how a finished run went, and how long it took", () => {
    expect(factoryTimelineSummary({ state: "done", startedAt: 0, endedAt: 9_000 }, [ok], 99_000)).toEqual({ tone: "done", text: "Finished in 9s" });
    expect(factoryTimelineSummary({ state: "merged", startedAt: 0, endedAt: 9_000 }, [ok, bad], 99_000)).toEqual({ tone: "wait", text: "Finished with 1 issue in 9s" });
  });

  it("counts a running run up to now, and names no time while it waits on you", () => {
    expect(factoryTimelineSummary({ state: "running", startedAt: 0, endedAt: null }, [ok], 75_000).text).toBe("Running for 1m 15s");
    expect(factoryTimelineSummary({ state: "needs-approval", startedAt: 0, endedAt: null }, [ok], 75_000)).toEqual({ tone: "wait", text: "Waiting on you" });
  });

  it("says a stop is an error when no failed step shows why", () => {
    expect(factoryTimelineSummary({ state: "error", startedAt: 0, endedAt: 5_000 }, [ok], 9_000).text).toBe("Stopped with an error after 5s");
    expect(factoryTimelineSummary({ state: "check-failed", startedAt: 0, endedAt: 5_000 }, [bad, bad], 9_000).text).toBe("Stopped with 2 issues after 5s");
  });
});
