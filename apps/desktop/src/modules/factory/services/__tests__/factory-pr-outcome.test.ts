import { describe, expect, it } from "vitest";
import type { GraphRunRecord } from "@/modules/codecanvas/services/graph-run-record";
import { factoryNodeId, factoryPrLabel, factoryRunView, factoryWorkflowId } from "@/modules/factory/services/factory-run";
import { factoryRunRows, groupFactoryRuns, needsYouCount } from "@/modules/factory/services/factory-run-list";
import { factoryRunDetail } from "@/modules/factory/services/factory-run-detail";
import { factoryBoardColumn, factoryCardLine } from "@/modules/factory/services/factory-board";
import { factoryStageBar } from "@/modules/factory/services/factory-progress";

const URL = "https://github.com/o/r/pull/12";

/** A finished run with its draft PR open, or ended as the reaper saw it (#147). */
function finished(pr?: "merged" | "closed", issue = 7): GraphRunRecord {
  const step = factoryNodeId("o/r", issue);
  return {
    id: `r-${pr ?? "open"}-${issue}`,
    projectId: "p",
    workflowId: factoryWorkflowId("o/r", issue),
    status: "completed",
    checkpoint: {
      nodeIds: [step],
      deps: [],
      completed: { [step]: { outcome: "completed", sessionId: null, nodeRunId: "n", detail: URL } },
      failed: [],
      pending: [],
      blocked: [],
      engine: {
        kind: "rust",
        factory: { repo: "o/r", issue, title: "T", body: "", account: "me", checkout: "/c", base: "main", implementer: "p1" },
        ...(pr ? { pr } : {}),
      },
    },
    startedAt: issue,
    endedAt: issue + 1,
    updatedAt: issue + 1,
  };
}

describe("telling a merged PR from an open one (#147)", () => {
  it("reads the PR number from its URL", () => {
    expect(factoryPrLabel(URL)).toBe("PR #12");
    expect(factoryPrLabel("https://example.com/x")).toBeNull();
    expect(factoryPrLabel(null)).toBeNull();
  });

  it("an open PR stays Ready to review", () => {
    const [row] = factoryRunRows([finished()]);
    expect(row.state).toBe("done");
    expect(row.group).toBe("ready");
    expect(factoryRunDetail(row).statusWord).toBe("Ready to review");
    expect(factoryBoardColumn(row)).toBe("ready");
  });

  it("a merged PR is Done, says PR #N merged, and nothing waits on you", () => {
    const [row] = factoryRunRows([finished("merged")]);
    expect(row.state).toBe("merged");
    expect(row.group).toBe("done");
    expect(factoryCardLine(row)).toBe("PR #12 merged");
    expect(factoryRunDetail(row)).toMatchObject({ statusWord: "Done", sentence: "PR #12 merged. Nothing is left to do.", primary: null });
    expect(factoryBoardColumn(row)).toBe("done");
    expect(factoryStageBar(row.progress, row.state).every((s) => s.status === "done")).toBe(true);
    expect(needsYouCount([row])).toBe(0);
    expect(factoryRunView(finished("merged")).canStart).toBe(false);
  });

  it("a PR closed without a merge is Stopped, not Done, and can be tried again", () => {
    const [row] = factoryRunRows([finished("closed")]);
    expect(row.state).toBe("pr-closed");
    expect(row.group).toBe("stopped");
    expect(factoryCardLine(row)).toBe("PR #12 closed without a merge");
    expect(factoryRunDetail(row)).toMatchObject({ statusWord: "Stopped", primary: "try-again" });
    expect(factoryBoardColumn(row)).toBeNull();
    expect(factoryRunView(finished("closed")).canStart).toBe(true);
  });

  it("puts Done after Ready to review in the list", () => {
    const groups = groupFactoryRuns(factoryRunRows([finished("merged", 1), finished(undefined, 2), finished("closed", 3)]));
    expect(groups.map((g) => g.label)).toEqual(["Ready to review", "Done", "Stopped"]);
  });
});

describe("Open vs Draft PRs (ADR-0063 §7)", () => {
  const withOpening = (prOpening?: { draft: boolean; reason?: string }) => {
    const record = finished();
    record.checkpoint.engine!.progress = { stage: "draft-pr", attempt: 1, maxAttempts: 2, steps: [], ...(prOpening ? { prOpening } : {}) } as never;
    return factoryRunRows([record])[0];
  };

  it("a run saved before Open PRs reads as a Draft", () => {
    expect(factoryCardLine(withOpening())).toBe("Draft PR open");
  });

  it("an Open PR says so, with no reason", () => {
    const view = withOpening({ draft: false });
    expect(factoryCardLine(view)).toBe("PR open");
    expect(factoryRunDetail(view).sentence).toContain("the PR is open");
  });

  it("a Draft PR says why", () => {
    const view = withOpening({ draft: true, reason: "The review did not run." });
    expect(factoryCardLine(view)).toBe("Draft PR open");
    expect(factoryRunDetail(view).sentence).toContain("Why a draft: The review did not run.");
  });
});
