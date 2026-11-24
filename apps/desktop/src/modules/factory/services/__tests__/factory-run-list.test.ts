import { describe, expect, it } from "vitest";
import type { GraphRunRecord, GraphRunStatus } from "@/modules/codecanvas/services/graph-run-record";
import {
  factoryRunElapsedMs,
  factoryRowKey,
  factoryRunRows,
  formatElapsed,
  groupFactoryRuns,
  needsYouCount,
} from "@/modules/factory/services/factory-run-list";
import { factoryNodeId, factoryWorkflowId } from "@/modules/factory/services/factory-run";

const TICKET = { body: "", account: "me", checkout: "/code/lotus", base: "main", implementer: "p1" };

function run(
  status: GraphRunStatus,
  over: { id?: string; repo?: string; issue?: number; title?: string; startedAt?: number; endedAt?: number | null; failedDetail?: string; pr?: string } = {},
): GraphRunRecord {
  const repo = over.repo ?? "o/r";
  const issue = over.issue ?? 7;
  const step = factoryNodeId(repo, issue);
  return {
    id: over.id ?? `run-${repo}-${issue}-${over.startedAt ?? 1}`,
    projectId: "p",
    workflowId: factoryWorkflowId(repo, issue),
    status,
    checkpoint: {
      nodeIds: [step],
      deps: [],
      completed: over.pr ? { [step]: { outcome: "completed", sessionId: null, nodeRunId: "", detail: over.pr } } : {},
      failed: [],
      ...(over.failedDetail !== undefined ? { failedDetail: { [step]: over.failedDetail } } : {}),
      pending: [],
      blocked: [],
      engine: { kind: "rust", budgetCap: 2, factory: { ...TICKET, repo, issue, title: over.title ?? "Fix it" } },
    },
    startedAt: over.startedAt ?? 1,
    endedAt: over.endedAt ?? null,
    updatedAt: over.startedAt ?? 1,
  };
}

describe("factoryRunRows", () => {
  it("reads the issue, title and state off each Factory Run", () => {
    const rows = factoryRunRows([run("running", { repo: "o/r", issue: 7, title: "Copy button keeps old text" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repo: "o/r", issue: 7, title: "Copy button keeps old text", state: "running", group: "working" });
  });

  it("keeps only the newest run of an issue", () => {
    const rows = factoryRunRows([
      run("error", { id: "old", startedAt: 1, failedDetail: "red" }),
      run("running", { id: "new", startedAt: 5 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["new"]);
  });

  it("treats another repo's issue with the same number as its own run", () => {
    const rows = factoryRunRows([run("running", { repo: "o/a", issue: 1 }), run("running", { repo: "o/b", issue: 1 })]);
    expect(rows).toHaveLength(2);
  });

  it("ignores runs that are not Factory Runs", () => {
    const plain = run("running");
    delete plain.checkpoint.engine!.factory;
    expect(factoryRunRows([plain])).toEqual([]);
  });

  it("carries the PR link, spend and cap of a finished run", () => {
    const [row] = factoryRunRows([run("completed", { pr: "https://github.com/o/r/pull/9", endedAt: 9 })]);
    expect(row).toMatchObject({ state: "done", group: "ready", prUrl: "https://github.com/o/r/pull/9", capUsd: 2 });
  });
});

describe("state → group", () => {
  const groupOf = (r: GraphRunRecord) => factoryRunRows([r])[0]?.group;

  it("a running run is working", () => expect(groupOf(run("running"))).toBe("working"));
  it("a paused run needs you", () => expect(groupOf(run("paused"))).toBe("needs-you"));
  it("a failed check needs you", () => expect(groupOf(run("error", { failedDetail: "red" }))).toBe("needs-you"));
  it("an engine error needs you", () => expect(groupOf(run("error"))).toBe("needs-you"));
  it("a completed run is ready to review", () => expect(groupOf(run("completed"))).toBe("ready"));
  it("a cancelled run is stopped", () => expect(groupOf(run("cancelled"))).toBe("stopped"));
});

describe("groupFactoryRuns", () => {
  const all = [
    run("completed", { issue: 1, startedAt: 1 }),
    run("running", { issue: 2, startedAt: 2 }),
    run("running", { issue: 3, startedAt: 3 }),
    run("error", { issue: 4, startedAt: 4, failedDetail: "red" }),
    run("cancelled", { issue: 5, startedAt: 5 }),
  ];

  it("orders the groups Needs you, Working, Ready to review, Stopped", () => {
    expect(groupFactoryRuns(factoryRunRows(all)).map((g) => g.label)).toEqual([
      "Needs you",
      "Working",
      "Ready to review",
      "Stopped",
    ]);
  });

  it("puts the newest run first inside a group", () => {
    const working = groupFactoryRuns(factoryRunRows(all)).find((g) => g.id === "working")!;
    expect(working.rows.map((r) => r.issue)).toEqual([3, 2]);
  });

  it("leaves out an empty group", () => {
    const groups = groupFactoryRuns(factoryRunRows([run("running")]));
    expect(groups.map((g) => g.id)).toEqual(["working"]);
  });

  it("gives no groups for no runs", () => {
    expect(groupFactoryRuns([])).toEqual([]);
  });
});

describe("needsYouCount", () => {
  it("counts only the runs that wait for a person", () => {
    const rows = factoryRunRows([
      run("running", { issue: 1 }),
      run("paused", { issue: 2 }),
      run("error", { issue: 3, failedDetail: "red" }),
      run("completed", { issue: 4 }),
    ]);
    expect(needsYouCount(rows)).toBe(2);
  });
});

describe("elapsed time", () => {
  it("counts a finished run from start to end", () => {
    const [row] = factoryRunRows([run("completed", { startedAt: 1_000, endedAt: 373_000 })]);
    expect(factoryRunElapsedMs(row, 999_999)).toBe(372_000);
  });

  it("counts a live run up to now", () => {
    const [row] = factoryRunRows([run("running", { startedAt: 1_000 })]);
    expect(factoryRunElapsedMs(row, 156_000)).toBe(155_000);
  });

  it("never goes below zero when the clock is behind", () => {
    const [row] = factoryRunRows([run("running", { startedAt: 5_000 })]);
    expect(factoryRunElapsedMs(row, 1_000)).toBe(0);
  });

  it("writes minutes and seconds", () => {
    expect(formatElapsed(372_000)).toBe("6:12");
    expect(formatElapsed(4_000)).toBe("0:04");
  });

  it("adds hours past one hour", () => {
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });
});

describe("progress on the row", () => {
  it("carries the run's progress, or null on an old run", () => {
    const old = run("running");
    expect(factoryRunRows([old])[0].progress).toBeNull();
    const now = run("running");
    now.checkpoint.engine!.progress = { stage: "checking", attempt: 1, maxAttempts: 2, steps: [] };
    expect(factoryRunRows([now])[0].progress?.stage).toBe("checking");
  });
});

describe("Revision Runs (CoS 6)", () => {
  const round = (status: GraphRunStatus, id: string, startedAt: number): GraphRunRecord => {
    const record = run(status, { id, startedAt });
    const revision = { original: "pr-run", prUrl: "u", prNumber: 9, branch: "factory/b", round: 1, items: [] };
    record.checkpoint.engine!.factory = { ...record.checkpoint.engine!.factory!, revision };
    return record;
  };

  it("a running round never takes the place of its PR's card", () => {
    const rows = factoryRunRows([run("completed", { id: "pr-run", startedAt: 1, pr: "https://github.com/o/r/pull/9" }), round("running", "round-1", 5)]);
    expect(rows.map((r) => r.id)).toEqual(["pr-run"]);
  });

  it("a round paused at its cap gets its own row, opened by its own key", () => {
    const rows = factoryRunRows([run("completed", { id: "pr-run", startedAt: 1, pr: "https://github.com/o/r/pull/9" }), round("paused", "round-1", 5)]);
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["pr-run", "done"],
      ["round-1", "paused"],
    ]);
    expect(new Set(rows.map(factoryRowKey)).size).toBe(2);
  });
});
