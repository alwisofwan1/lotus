import { describe, expect, it } from "vitest";
import type { FactoryProgress, FactoryStage } from "@/lib/tauri/graph-run";
import { factoryProgressLine, factoryStageBar, factoryStepRows, factoryTries } from "@/modules/factory/services/factory-progress";

function progress(stage: FactoryStage, attempt = 1, steps: FactoryProgress["steps"] = []): FactoryProgress {
  return { stage, attempt, maxAttempts: 2, steps };
}

const bar = (p: FactoryProgress | null, state: Parameters<typeof factoryStageBar>[1]) =>
  factoryStageBar(p, state).map((s) => `${s.stage}:${s.status}`);

describe("factoryProgressLine", () => {
  it("names the stage and the try", () => {
    expect(factoryProgressLine(progress("checking", 1))).toBe("Checking · try 1 of 2");
    expect(factoryProgressLine(progress("building", 2))).toBe("Building · try 2 of 2");
  });

  it("leaves the try out where there is no try to count", () => {
    expect(factoryProgressLine(progress("worktree"))).toBe("Making the worktree");
    expect(factoryProgressLine(progress("draft-pr", 2))).toBe("Opening the draft PR");
  });

  it("is nothing for a run with no progress saved", () => {
    expect(factoryProgressLine(null)).toBeNull();
  });
});

describe("factoryStageBar", () => {
  it("always has the seven stages in order", () => {
    expect(factoryStageBar(null, "running").map((s) => s.label)).toEqual(["Triage", "Worktree", "Spec", "Build", "Check", "Review", "Draft PR"]);
  });

  it("working: the stages before are done, the current one is active", () => {
    expect(bar(progress("checking"), "running")).toEqual(["triage:done", "worktree:done", "spec:done", "building:done", "checking:active", "review:todo", "draft-pr:todo"]);
  });

  it("a failed check marks the check as failed", () => {
    expect(bar(progress("checking", 2), "check-failed")).toEqual(["triage:done", "worktree:done", "spec:done", "building:done", "checking:failed", "review:todo", "draft-pr:todo"]);
  });

  it("an engine error marks the stage it stopped on as failed", () => {
    expect(bar(progress("building"), "error")).toEqual(["triage:done", "worktree:done", "spec:done", "building:failed", "checking:todo", "review:todo", "draft-pr:todo"]);
  });

  it("paused at the cap marks the current stage as needing you", () => {
    expect(bar(progress("checking", 1), "paused")).toEqual(["triage:done", "worktree:done", "spec:done", "building:done", "checking:needs-you", "review:todo", "draft-pr:todo"]);
  });

  it("done: every stage is done", () => {
    expect(bar(progress("draft-pr", 2), "done")).toEqual(["triage:done", "worktree:done", "spec:done", "building:done", "checking:done", "review:done", "draft-pr:done"]);
    expect(bar(null, "done")).toEqual(["triage:done", "worktree:done", "spec:done", "building:done", "checking:done", "review:done", "draft-pr:done"]);
  });

  it("stopped: what ran stays done, the rest is left undone", () => {
    expect(bar(progress("building"), "stopped")).toEqual(["triage:done", "worktree:done", "spec:done", "building:todo", "checking:todo", "review:todo", "draft-pr:todo"]);
  });

  it("waiting on the intake marks the spec as needing you", () => {
    expect(bar(progress("spec"), "needs-answers")).toEqual(["triage:done", "worktree:done", "spec:needs-you", "building:todo", "checking:todo", "review:todo", "draft-pr:todo"]);
    expect(bar(progress("spec"), "needs-approval")).toEqual(["triage:done", "worktree:done", "spec:needs-you", "building:todo", "checking:todo", "review:todo", "draft-pr:todo"]);
  });

  it("a run its triage stopped marks the triage as needing you", () => {
    expect(bar(progress("triage"), "triage-blocked")).toEqual(["triage:needs-you", "worktree:todo", "spec:todo", "building:todo", "checking:todo", "review:todo", "draft-pr:todo"]);
    expect(factoryProgressLine(progress("triage"))).toBe("Triaging the ticket");
  });

  it("a run with no progress saved shows nothing done while it works", () => {
    expect(bar(null, "running")).toEqual(["triage:todo", "worktree:todo", "spec:todo", "building:todo", "checking:todo", "review:todo", "draft-pr:todo"]);
  });
});

describe("factoryStepRows", () => {
  it("lists each stage with its try, how long it took and its cost", () => {
    const rows = factoryStepRows(
      progress("checking", 1, [
        { stage: "worktree", attempt: 1, startedAt: 0, endedAt: 2_000 },
        { stage: "building", attempt: 1, startedAt: 2_000, endedAt: 92_000, costUsd: 0.31 },
        { stage: "checking", attempt: 1, startedAt: 92_000 },
      ]),
      100_000,
    );
    expect(rows).toEqual([
      { label: "Worktree", attempt: null, durationMs: 2_000, costUsd: null, running: false },
      { label: "Build", attempt: 1, durationMs: 90_000, costUsd: 0.31, running: false },
      { label: "Check", attempt: 1, durationMs: 8_000, costUsd: null, running: true },
    ]);
  });

  it("is empty with no progress", () => {
    expect(factoryStepRows(null, 0)).toEqual([]);
  });
});

describe("factoryTries", () => {
  const cells = (p: FactoryProgress | null, state: Parameters<typeof factoryTries>[1]) => factoryTries(p, state)?.cells ?? null;

  it("counts nothing before Build, or when only one try is allowed", () => {
    expect(cells(progress("spec"), "running")).toBeNull();
    expect(cells({ ...progress("building"), maxAttempts: 1 }, "running")).toBeNull();
    expect(cells(null, "running")).toBeNull();
  });

  it("the first try building: one live, the rest not reached", () => {
    expect(factoryTries(progress("building"), "running")).toEqual({ cells: ["active", "todo"], label: "try 1 of 2" });
  });

  it("a second try means the first failed its check", () => {
    expect(cells(progress("building", 2), "running")).toEqual(["failed", "active"]);
  });

  it("out of tries: the last one failed too", () => {
    expect(cells(progress("checking", 2), "check-failed")).toEqual(["failed", "failed"]);
  });

  it("past Check the current try passed", () => {
    expect(cells(progress("review", 2), "running")).toEqual(["failed", "done"]);
    expect(cells(progress("draft-pr"), "done")).toEqual(["done", "todo"]);
  });

  it("paused at the cap mid-try waits on you", () => {
    expect(cells(progress("checking"), "paused")).toEqual(["needs-you", "todo"]);
  });
});
