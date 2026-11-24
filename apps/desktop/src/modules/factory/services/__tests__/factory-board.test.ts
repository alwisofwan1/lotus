import { describe, expect, it } from "vitest";
import type { FactoryProgress, FactoryStage } from "@/lib/tauri/graph-run";
import { factoryBoardColumn, factoryBoardColumns, factoryCardLine, factoryIntakeWaiting } from "@/modules/factory/services/factory-board";
import type { FactoryRunState } from "@/modules/factory/services/factory-run";
import type { FactoryGroupId, FactoryRunRow } from "@/modules/factory/services/factory-run-list";

const GROUP: Record<FactoryRunState, FactoryGroupId> = {
  idle: "stopped",
  running: "working",
  paused: "needs-you",
  "recovery-required": "needs-you",
  "needs-answers": "needs-you",
  "needs-approval": "needs-you",
  "triage-blocked": "needs-you",
  "check-failed": "needs-you",
  error: "needs-you",
  done: "ready",
  merged: "done",
  "pr-closed": "stopped",
  stopped: "stopped",
};

const progress = (stage: FactoryStage): FactoryProgress => ({ stage, attempt: 1, maxAttempts: 2, steps: [] });

function row(state: FactoryRunState, stage: FactoryStage | null = null, over: Partial<FactoryRunRow> = {}): FactoryRunRow {
  return {
    id: "r",
    projectId: "p",
    repo: "o/r",
    issue: 1,
    title: "T",
    state,
    group: GROUP[state],
    startedAt: 0,
    endedAt: null,
    spentUsd: null,
    capUsd: null,
    prUrl: null,
    output: null,
    progress: stage ? progress(stage) : null,
    intake: null,
    ticket: { repo: "o/r", issue: 1, title: "T", body: "", account: "me", checkout: "/c", base: "main", implementer: "p1" },
    ...over,
  };
}

describe("factoryBoardColumn", () => {
  it("a working run sits in the column of its stage", () => {
    expect(factoryBoardColumn(row("running"))).toBe("queued");
    expect(factoryCardLine(row("running"))).toBe("Waiting in line");
    expect(factoryBoardColumn(row("running", "worktree"))).toBe("queued");
    expect(factoryBoardColumn(row("running", "building"))).toBe("building");
    expect(factoryBoardColumn(row("running", "checking"))).toBe("checking");
    expect(factoryBoardColumn(row("running", "draft-pr"))).toBe("checking");
  });

  it("a run that waits on you is in Needs you, whatever its stage", () => {
    expect(factoryBoardColumn(row("paused", "building"))).toBe("needs-you");
    expect(factoryBoardColumn(row("check-failed", "checking"))).toBe("needs-you");
    expect(factoryBoardColumn(row("error"))).toBe("needs-you");
  });

  it("a done run is ready to review; a stopped one is not on the board", () => {
    expect(factoryBoardColumn(row("done", "draft-pr"))).toBe("ready");
    expect(factoryBoardColumn(row("stopped", "building"))).toBeNull();
    expect(factoryBoardColumn(row("idle"))).toBeNull();
  });
});

describe("factoryBoardColumns", () => {
  it("always the six columns in order, newest card first, stopped runs left out", () => {
    const columns = factoryBoardColumns([
      row("running", "building", { id: "old", startedAt: 1 }),
      row("running", "building", { id: "new", startedAt: 2 }),
      row("stopped", null, { id: "gone" }),
    ]);
    expect(columns.map((c) => c.label)).toEqual(["Needs you", "Queued", "Building", "Checking", "Ready to review", "Done"]);
    expect(columns[2].rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(columns.flatMap((c) => c.rows).some((r) => r.id === "gone")).toBe(false);
  });
});

describe("factoryIntakeWaiting", () => {
  it("only runs waiting on their intake, newest first, with what they wait for", () => {
    const items = factoryIntakeWaiting([
      row("needs-answers", "spec", { id: "a", startedAt: 1 }),
      row("paused", "building", { id: "p", startedAt: 3 }),
      row("needs-approval", "spec", { id: "b", startedAt: 2 }),
    ]);
    expect(items.map((i) => [i.id, i.line])).toEqual([
      ["b", "Spec ready to approve"],
      ["a", "Questions for you"],
    ]);
    expect(items[0].title).toBe("#1 T");
  });

  it("a run its triage stopped is in Inbox and Needs you, saying why", () => {
    const triage = { duplicates: [], labels: [], notes: [], duplicatesAccepted: false, refusalOverridden: false, at: 1 };
    const dup = { ...triage, duplicates: [{ kind: "branch" as const, branch: "fix/1" }] };
    const refused = row("triage-blocked", "triage", { id: "t", intake: { turns: [], approved: false, triage } });
    const duplicated = row("triage-blocked", "triage", { id: "d", startedAt: 1, intake: { turns: [], approved: false, triage: dup } });
    expect(factoryBoardColumn(refused)).toBe("needs-you");
    expect(factoryIntakeWaiting([refused, duplicated]).map((i) => [i.id, i.line])).toEqual([
      ["d", "Work on this issue already exists"],
      ["t", "Triage advises not to build it"],
    ]);
  });

  it("a run in triage sits in Building", () => {
    expect(factoryBoardColumn(row("running", "triage"))).toBe("building");
    expect(factoryCardLine(row("running", "triage"))).toBe("Triaging the ticket");
  });

  it("a run writing its spec sits in Building", () => {
    expect(factoryBoardColumn(row("running", "spec"))).toBe("building");
    expect(factoryCardLine(row("running", "spec"))).toBe("Writing the spec");
  });
});

