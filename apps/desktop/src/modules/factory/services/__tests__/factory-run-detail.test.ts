import { describe, expect, it } from "vitest";
import type { GraphRunRecord, GraphRunStatus } from "@/modules/codecanvas/services/graph-run-record";
import { factoryNodeId, factoryWorkflowId } from "@/modules/factory/services/factory-run";
import { factoryRunRows } from "@/modules/factory/services/factory-run-list";
import { DEFAULT_CAP_USD } from "@/modules/factory/services/factory-run";
import { factoryRetryInput, factoryRunDetail, failingLines } from "@/modules/factory/services/factory-run-detail";

const TICKET = { repo: "o/r", issue: 7, title: "Copy button", body: "Steps", account: "me", checkout: "/code/r", base: "main", implementer: "p1" };

function record(status: GraphRunStatus, over: { failedDetail?: string; error?: string; pr?: string; cost?: number } = {}): GraphRunRecord {
  const step = factoryNodeId("o/r", 7);
  return {
    id: "run-1",
    projectId: "proj",
    workflowId: factoryWorkflowId("o/r", 7),
    status,
    checkpoint: {
      nodeIds: [step],
      deps: [],
      completed: over.pr
        ? { [step]: { outcome: "completed", sessionId: null, nodeRunId: "", detail: over.pr, usage: { inputTokens: 0, outputTokens: 0, costUsd: over.cost ?? 1.2 } } }
        : {},
      failed: [],
      ...(over.failedDetail !== undefined ? { failedDetail: { [step]: over.failedDetail } } : {}),
      ...(over.cost !== undefined && !over.pr ? { failedUsage: { [step]: { inputTokens: 0, outputTokens: 0, costUsd: over.cost } } } : {}),
      pending: [],
      blocked: [],
      engine: { kind: "rust", budgetCap: 2, factory: TICKET, ...(over.error ? { error: over.error } : {}) },
    },
    startedAt: 1,
    endedAt: null,
    updatedAt: 1,
  };
}

const detailOf = (r: GraphRunRecord) => factoryRunDetail(factoryRunRows([r])[0]);

describe("factoryRunDetail", () => {
  it("working: says so, no filled button, Abort as an icon", () => {
    const d = detailOf(record("running"));
    expect(d.statusWord).toBe("Working");
    // No stage yet: past the limit of 3, it waits for a place and has no worktree.
    expect(d.sentence).toBe("Waiting in line. Up to 3 runs work at once, so it starts when one ends.");
    expect(d.primary).toBeNull();
    expect(d.secondary).toEqual(["abort"]);
  });

  it("needs you, check failed: Try again", () => {
    const d = detailOf(record("error", { failedDetail: "FAIL a.test.ts" }));
    expect(d.statusWord).toBe("Needs you");
    expect(d.sentence).toMatch(/check failed/i);
    expect(d.primary).toBe("try-again");
    expect(d.secondary).toEqual([]);
  });

  it("requires recovery inspection without offering ordinary retry or budget actions", () => {
    const r = record("paused");
    r.checkpoint.engine!.recovery = "Inspect retained worktree";
    expect(detailOf(r)).toMatchObject({ statusWord: "Recovery required", primary: null, secondary: ["abort"] });
  });

  it("needs you, paused at the cap: Raise cap, and says the spend", () => {
    const d = detailOf(record("paused", { cost: 2.05 }));
    expect(d.statusWord).toBe("Needs you");
    expect(d.sentence).toContain("$2.05 of $2.00");
    expect(d.primary).toBe("raise-cap");
    expect(d.secondary).toEqual(["abort"]);
  });

  it("needs you, engine error: Try again, and says why", () => {
    const d = detailOf(record("error", { error: "no runner" }));
    expect(d.statusWord).toBe("Needs you");
    expect(d.sentence).toContain("no runner");
    expect(d.primary).toBe("try-again");
  });

  it("ready to review: Review PR", () => {
    const d = detailOf(record("completed", { pr: "https://github.com/o/r/pull/9" }));
    expect(d.statusWord).toBe("Ready to review");
    expect(d.sentence).toMatch(/draft PR/i);
    expect(d.primary).toBe("review-pr");
    expect(d.secondary).toEqual([]);
  });

  it("ready to review: a draft's sentence is punctuated and never claims a check", () => {
    const withOpening = (prOpening: { draft: boolean; reason?: string }) => {
      const r = record("completed", { pr: "https://github.com/o/r/pull/9" });
      r.checkpoint.engine!.progress = { prOpening } as never;
      return detailOf(r).sentence;
    };
    expect(withOpening({ draft: true, reason: "The repo has no gate." })).toBe("A draft PR is open. Why a draft: The repo has no gate. The merge is yours.");
    expect(withOpening({ draft: true })).toBe("A draft PR is open. The merge is yours.");
    expect(withOpening({ draft: false })).toBe("The review accepted it and the PR is open. The merge is yours.");
  });

  it("ready but no PR link: nothing to open", () => {
    const d = detailOf(record("completed"));
    expect(d.primary).toBeNull();
  });

  it("stopped: Try again", () => {
    const d = detailOf(record("cancelled"));
    expect(d.statusWord).toBe("Stopped");
    expect(d.primary).toBe("try-again");
  });

  it("never has more than one primary action", () => {
    for (const s of ["running", "paused", "completed", "cancelled", "error"] as const) {
      const d = detailOf(record(s, { pr: s === "completed" ? "u" : undefined }));
      expect(d.secondary).not.toContain(d.primary);
    }
  });
});

describe("failingLines", () => {
  it("picks the lines that say what failed", () => {
    const out = ["RUN v4", " ✓ a.test.ts", " FAIL b.test.ts > adds", "AssertionError: expected 1 to be 2", "Tests 1 failed | 9 passed"].join("\n");
    expect(failingLines(out)).toEqual([" FAIL b.test.ts > adds", "AssertionError: expected 1 to be 2", "Tests 1 failed | 9 passed"]);
  });

  it("falls back to the last lines when none say fail", () => {
    const out = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(failingLines(out, 3)).toEqual(["line 17", "line 18", "line 19"]);
  });

  it("caps how many lines it shows", () => {
    const out = Array.from({ length: 20 }, (_, i) => `error ${i}`).join("\n");
    expect(failingLines(out, 4)).toHaveLength(4);
  });

  it("gives nothing for no output", () => {
    expect(failingLines(null)).toEqual([]);
    expect(failingLines("  \n ")).toEqual([]);
  });
});

describe("factoryRetryInput", () => {
  it("starts the same issue again in the same project, with the same cap and agent", () => {
    const input = factoryRetryInput(factoryRunRows([record("error", { failedDetail: "x" })])[0]);
    expect(input.projectId).toBe("proj");
    expect(input.workflowId).toBe(factoryWorkflowId("o/r", 7));
    expect(input.factory).toMatchObject({ repo: "o/r", issue: 7, body: "Steps", checkout: "/code/r", implementer: "p1", account: "me" });
    expect(input.budgetCap).toBe(2);
    expect(input.factory?.previousFailure).toBe("x");
  });

  it("uses the issue as it is now, and carries why the last run stopped", () => {
    const input = factoryRetryInput(factoryRunRows([record("error", { error: "agent crashed" })])[0], { title: "New", body: null });
    expect(input.factory).toMatchObject({ title: "New", body: "", previousFailure: "agent crashed" });
  });

  it("a stopped or closed run has nothing to carry, and a run with no cap gets the default one", () => {
    const stopped = factoryRunRows([record("cancelled")])[0];
    expect(factoryRetryInput(stopped).factory?.previousFailure).toBeUndefined();
    expect(factoryRetryInput({ ...stopped, capUsd: null }).budgetCap).toBe(DEFAULT_CAP_USD);
  });
});

describe("factoryRunDetail with progress", () => {
  it("working: the sentence says the stage and the try", () => {
    const r = record("running");
    r.checkpoint.engine!.progress = { stage: "checking", attempt: 1, maxAttempts: 2, steps: [] };
    expect(factoryRunDetail(factoryRunRows([r])[0]).sentence).toBe("Checking · try 1 of 2");
  });
});
