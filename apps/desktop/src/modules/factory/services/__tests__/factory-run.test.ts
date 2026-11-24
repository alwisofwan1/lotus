import { describe, expect, it } from "vitest";
import {
  factoryNodeId,
  factoryRunView,
  factoryStartInput,
  factoryWorkflowId,
  intakeWaitsFor,
  latestFactoryRun,
  openIntakeTurn,
  triageBlock,
} from "@/modules/factory/services/factory-run";
import type { GraphRunRecord, GraphRunStatus } from "@/modules/codecanvas/services/graph-run-record";

const FACTORY_NODE_ID = factoryNodeId("o/r", 7);

function record(status: GraphRunStatus, patch: Partial<GraphRunRecord["checkpoint"]> = {}, extra: Partial<GraphRunRecord> = {}): GraphRunRecord {
  return {
    id: "r1",
    projectId: "cp_1",
    workflowId: factoryWorkflowId("o/r", 7),
    status,
    checkpoint: {
      nodeIds: [FACTORY_NODE_ID],
      deps: [],
      completed: {},
      failed: [],
      pending: status === "running" || status === "paused" ? [FACTORY_NODE_ID] : [],
      blocked: [],
      engine: { kind: "rust", budgetCap: 2 },
      ...patch,
    },
    startedAt: 1,
    endedAt: status === "running" || status === "paused" ? null : 2,
    updatedAt: 2,
    ...extra,
  };
}

const ticket = {
  projectId: "cp_1",
  repo: "o/r",
  issue: { number: 7, title: "Fix it", body: null },
  account: "me",
  checkout: "/code/r",
  implementer: "claude",
  budgetCap: 2,
};

describe("factory run", () => {
  it("names a ticket's runs by repo and issue, case-insensitively", () => {
    expect(factoryWorkflowId("Owner/Repo", 7)).toBe("factory:owner/repo#7");
  });

  it("picks the newest run of the ticket and ignores other workflows", () => {
    const old = record("error", {}, { id: "old", startedAt: 1 });
    const fresh = record("running", {}, { id: "new", startedAt: 5 });
    const other = record("running", {}, { id: "x", startedAt: 9, workflowId: "factory:o/r#8" });
    expect(latestFactoryRun([old, other, fresh], "o/r", 7)?.id).toBe("new");
    expect(latestFactoryRun([other], "o/r", 7)).toBeNull();
  });

  it("gives each ticket its own step, so two tickets can run at once", () => {
    // The engine lets a step id live in one run at a time (ADR-0049): one shared id blocked every second ticket.
    expect(factoryNodeId("Owner/Repo", 7)).toBe("factory:owner/repo#7");
    expect(factoryNodeId("o/r", 7)).not.toBe(factoryNodeId("o/r", 8));
    const a = factoryStartInput({ ...ticket, issue: { number: 7, title: "a", body: null } });
    const b = factoryStartInput({ ...ticket, issue: { number: 8, title: "b", body: null } });
    expect(a.graph.nodeIds.filter((id) => b.graph.nodeIds.includes(id))).toEqual([]);
  });

  it("reads a run made before steps were named per ticket (step id \"factory\")", () => {
    const pr = "https://github.com/o/r/pull/85";
    const old = record("completed", {
      nodeIds: ["factory"],
      completed: { factory: { outcome: "completed", sessionId: null, nodeRunId: "", detail: pr } },
    });
    expect(factoryRunView(old)).toMatchObject({ state: "done", prUrl: pr });
    const red = record("error", { nodeIds: ["factory"], failed: ["factory"], failedDetail: { factory: "tsc: 1 error" } });
    expect(factoryRunView(red)).toMatchObject({ state: "check-failed", output: "tsc: 1 error" });
  });

  it("is idle with no run, and can start", () => {
    expect(factoryRunView(null)).toMatchObject({ state: "idle", canStart: true });
  });

  it("is running while the step runs, and cannot start another", () => {
    const view = factoryRunView(record("running", { failedUsage: { [FACTORY_NODE_ID]: { inputTokens: 0, outputTokens: 0, costUsd: 0.4 } } }));
    expect(view).toMatchObject({ state: "running", canStart: false, canAbort: true, canRaiseCap: false, spentUsd: 0.4, capUsd: 2 });
  });

  it("distinguishes interrupted Factory recovery from a budget pause", () => {
    expect(factoryRunView(record("paused", { engine: { kind: "rust", budgetCap: 2, recovery: "Inspect retained worktree" } }))).toMatchObject({
      state: "recovery-required", output: "Inspect retained worktree", canStart: false, canRaiseCap: false, canAbort: true,
    });
  });

  it("is paused at its cap with Raise cap and Abort", () => {
    expect(factoryRunView(record("paused"))).toMatchObject({ state: "paused", canStart: false, canRaiseCap: true, canAbort: true });
  });

  it("waits for answers, then for approval, holding its issue with Abort only", () => {
    const question = { question: "Which?", choices: ["A", "B"], recommended: "A", why: "" };
    const asked = { kind: "rust" as const, budgetCap: 2, intake: { turns: [{ kind: "asked" as const, questions: [question], at: 1 }], approved: false } };
    const view = factoryRunView(record("waiting", { engine: asked }));
    expect(view).toMatchObject({ state: "needs-answers", canStart: false, canRaiseCap: false, canAbort: true });
    expect(view.intake?.turns).toHaveLength(1);
    const spec = { ...asked, intake: { turns: [{ kind: "spec" as const, markdown: "# S", live: false, at: 2 }], approved: false } };
    expect(factoryRunView(record("waiting", { engine: spec })).state).toBe("needs-approval");
  });

  it("is triage-blocked while a refusal or a duplicate waits, and goes on once continued", () => {
    const report = {
      size: "S" as const,
      readiness: {
        scope: "clear", dataModel: "clear", uxFlow: "clear", nonFunctional: "clear", integrations: "clear",
        edgeCases: "clear", constraints: "clear", terminology: "clear", completion: "clear",
      } as const,
      score: "green" as const,
      verdict: "refuse" as const,
      reason: "r",
      summary: "s",
      files: [],
    };
    const triage = { report, duplicates: [], labels: [], notes: [], duplicatesAccepted: false, refusalOverridden: false, at: 1 };
    const engine = (t: typeof triage) => ({ kind: "rust" as const, budgetCap: 2, intake: { turns: [], approved: false, triage: t } });
    expect(factoryRunView(record("waiting", { engine: engine(triage) }))).toMatchObject({ state: "triage-blocked", canAbort: true, canStart: false });
    expect(triageBlock({ ...triage, duplicates: [{ kind: "branch", branch: "fix/7" }] })).toBe("duplicates");
    expect(triageBlock({ ...triage, refusalOverridden: true })).toBeNull();
    expect(intakeWaitsFor(engine({ ...triage, refusalOverridden: true }).intake)).toBeNull();
    expect(openIntakeTurn(engine(triage).intake)).toBeNull();
  });

  it("shows the gate output when the Check failed", () => {
    const view = factoryRunView(record("error", { failed: [FACTORY_NODE_ID], failedDetail: { [FACTORY_NODE_ID]: "tsc: 2 errors" } }));
    expect(view).toMatchObject({ state: "check-failed", output: "tsc: 2 errors", canStart: true, canAbort: false });
  });

  it("shows the engine's own error when no step failed", () => {
    const view = factoryRunView(record("error", { engine: { kind: "rust", error: "no runner" } }));
    expect(view).toMatchObject({ state: "error", output: "no runner" });
  });

  it("is done with the draft PR link", () => {
    const pr = "https://github.com/o/r/pull/9";
    const view = factoryRunView(record("completed", {
      completed: { [FACTORY_NODE_ID]: { outcome: "completed", sessionId: null, nodeRunId: "", detail: pr, usage: { inputTokens: 0, outputTokens: 0, costUsd: 1.25 } } },
    }));
    expect(view).toMatchObject({ state: "done", prUrl: pr, spentUsd: 1.25, canStart: false });
  });

  it("is stopped after Abort and may start again", () => {
    expect(factoryRunView(record("cancelled"))).toMatchObject({ state: "stopped", canStart: true });
  });

  it("builds the Rust start request from the ticket", () => {
    const input = factoryStartInput({ ...ticket, budgetCap: 3 });
    expect(input).toEqual({
      projectId: "cp_1",
      graph: { nodeIds: ["factory:o/r#7"], deps: [] },
      workflowId: "factory:o/r#7",
      run: { title: "Fix it (#7)", brief: "Factory Run for o/r#7" },
      budgetCap: 3,
      factory: { repo: "o/r", issue: 7, title: "Fix it", body: "", account: "me", checkout: "/code/r", base: "", implementer: "claude" },
    });
  });

  it("carries the run's progress, or null with no run or on an old run", () => {
    expect(factoryRunView(null).progress).toBeNull();
    expect(factoryRunView(record("running")).progress).toBeNull();
    const progress = { stage: "building" as const, attempt: 1, maxAttempts: 2, steps: [] };
    expect(factoryRunView(record("running", { engine: { kind: "rust", budgetCap: 2, progress } })).progress).toEqual(progress);
  });
});

describe("triageBlock: more than one sub-repo", () => {
  it("blocks a meta-repo run routed to two sub-repos, whatever the verdict", () => {
    const triage = { duplicates: [], report: { verdict: "go", repos: ["api", "web"] } } as unknown as Parameters<typeof triageBlock>[0];
    expect(triageBlock(triage)).toBe("multi-repo");
    const one = { duplicates: [], report: { verdict: "go", repos: ["api"] } } as unknown as Parameters<typeof triageBlock>[0];
    expect(triageBlock(one)).toBeNull();
  });
});
