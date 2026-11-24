import { describe, expect, it } from "vitest";
import type { FactoryChiefLog, FactoryFeedbackItem, FactoryPrWatch } from "@/lib/tauri/graph-run";
import {
  factoryCardPrLine,
  factoryChiefInbox,
  factoryChiefItems,
  factoryChiefLog,
  factoryChiefStripLine,
  factoryFeedbackNeedingYou,
  factoryFeedbackNotCounted,
  factoryFeedbackPlace,
  factoryPrsInReview,
  factoryReplyDrafts,
  factoryRoundBlocked,
} from "@/modules/factory/services/factory-chief";
import { factoryPrChip, factoryRoundLines } from "@/modules/factory/services/factory-board";
import type { FactoryRunState } from "@/modules/factory/services/factory-run";
import { factoryGroupOf, type FactoryRunRow } from "@/modules/factory/services/factory-run-list";

function row(id: string, state: FactoryRunState, chief: FactoryChiefLog | null = null, over: Partial<FactoryRunRow> = {}): FactoryRunRow {
  return {
    id,
    projectId: "p",
    repo: "o/r",
    issue: Number(id.replace(/\D/g, "")) || 1,
    title: `T ${id}`,
    state,
    group: factoryGroupOf(state),
    startedAt: 0,
    endedAt: null,
    spentUsd: 0.6,
    capUsd: 0.5,
    prUrl: null,
    output: null,
    progress: null,
    intake: null,
    ticket: { repo: "o/r", issue: 1, title: "T", body: "", account: "me", checkout: "/c", base: "main", implementer: "p1" },
    chief,
    ...over,
  };
}

const paused = (at: number, text = "Paused at the cap: spent $0.60 of $0.50."): FactoryChiefLog => ({
  log: [{ at, signal: "paused-at-cap", raised: true, text }],
  open: ["paused-at-cap"],
});

describe("factoryChiefItems", () => {
  it("a raised signal whose condition holds is an item with its reason and the user's actions", () => {
    const items = factoryChiefItems([row("r1", "paused", paused(1_000))]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "factory:o/r#1",
      signal: "paused-at-cap",
      reason: "Paused at the cap: spent $0.60 of $0.50.",
      at: 1_000,
      actions: ["raise-cap", "abort"],
    });
  });

  it("a signal the watcher has not cleared yet shows nothing once the run moved on", () => {
    expect(factoryChiefItems([row("r1", "running", paused(1_000))])).toEqual([]);
    expect(factoryChiefItems([row("r1", "stopped", paused(1_000))])).toEqual([]);
  });

  it("a paused run the Chief of Staff has not noted yet is not an item", () => {
    expect(factoryChiefItems([row("r1", "paused")])).toEqual([]);
  });

  it("a cleared signal is not an item even when the run paused again before the next look", () => {
    const cleared: FactoryChiefLog = {
      log: [...paused(1_000).log, { at: 2_000, signal: "paused-at-cap", raised: false, text: "Running again." }],
      open: [],
    };
    expect(factoryChiefItems([row("r1", "paused", cleared)])).toEqual([]);
  });

  it("the newest raise gives the reason", () => {
    const again: FactoryChiefLog = {
      log: [
        ...paused(1_000, "old").log,
        { at: 2_000, signal: "paused-at-cap", raised: false, text: "Running again." },
        { at: 3_000, signal: "paused-at-cap", raised: true, text: "new" },
      ],
      open: ["paused-at-cap"],
    };
    expect(factoryChiefItems([row("r1", "paused", again)])[0]).toMatchObject({ reason: "new", at: 3_000 });
  });
});

describe("factoryChiefItems for the other run signals", () => {
  const raised = (signal: FactoryChiefLog["open"][number], at: number, text = "why"): FactoryChiefLog => ({
    log: [{ at, signal, raised: true, text }],
    open: [signal],
  });
  const building = (steps: { startedAt: number; endedAt?: number }[], lastOutput?: { at: number; text: string }) => ({
    stage: "building" as const,
    attempt: 1,
    maxAttempts: 2,
    steps: steps.map((s) => ({ stage: "building" as const, attempt: 1, ...s })),
    lastOutput,
  });

  it("each signal offers its own clicks: Open run where the user acts in the run, Open worktree to inspect", () => {
    const actions = (signal: FactoryChiefLog["open"][number], state: FactoryRunState) =>
      factoryChiefItems([row("r1", state, raised(signal, 1_000), { progress: building([{ startedAt: 0 }]) })])[0]?.actions;
    expect(actions("waiting-on-you", "needs-answers")).toEqual(["open-run", "abort"]);
    expect(actions("stalled", "running")).toEqual(["open-worktree", "abort"]);
    expect(actions("recovery-required", "recovery-required")).toEqual(["open-worktree", "abort"]);
    expect(actions("budget-burn", "running")).toEqual(["open-run", "abort"]);
  });

  it("waiting on you shows while the run waits for answers, approval or a triage decision", () => {
    for (const state of ["needs-answers", "needs-approval", "triage-blocked"] as const) {
      expect(factoryChiefItems([row("r1", state, raised("waiting-on-you", 1_000))])).toHaveLength(1);
    }
    expect(factoryChiefItems([row("r1", "running", raised("waiting-on-you", 1_000))])).toEqual([]);
  });

  it("a stalled run that took a step since the watcher looked is not an item", () => {
    const stalled = raised("stalled", 5_000);
    expect(factoryChiefItems([row("r1", "running", stalled, { progress: building([{ startedAt: 1_000 }], { at: 2_000, text: "Edited a" }) })])).toHaveLength(1);
    expect(factoryChiefItems([row("r1", "running", stalled, { progress: building([{ startedAt: 1_000 }], { at: 6_000, text: "Ran tests" }) })])).toEqual([]);
    expect(factoryChiefItems([row("r1", "running", stalled, { progress: building([{ startedAt: 1_000, endedAt: 7_000 }]) })])).toEqual([]);
  });

  it("a run held for recovery shows only its recovery item, never paused at the cap", () => {
    const both: FactoryChiefLog = {
      log: [...raised("recovery-required", 1_000).log, ...paused(1_000).log],
      open: ["recovery-required", "paused-at-cap"],
    };
    const items = factoryChiefItems([row("r1", "recovery-required", both)]);
    expect(items.map((i) => i.signal)).toEqual(["recovery-required"]);
  });

  it("the 80% warning shows while the run works or waits, and gives way to the pause", () => {
    expect(factoryChiefItems([row("r1", "running", raised("budget-burn", 1_000))])).toHaveLength(1);
    expect(factoryChiefItems([row("r1", "needs-approval", raised("budget-burn", 1_000))])).toHaveLength(1);
    expect(factoryChiefItems([row("r1", "paused", raised("budget-burn", 1_000))])).toEqual([]);
  });
});

describe("factoryChiefInbox", () => {
  it("puts Needs you first, newest first, and lists running runs below as nothing to do", () => {
    const inbox = factoryChiefInbox([
      row("r1", "paused", paused(1_000)),
      row("r2", "paused", paused(5_000)),
      row("r3", "running", null, { startedAt: 10 }),
      row("r4", "running", null, { startedAt: 20 }),
      row("r5", "done"),
    ]);
    expect(inbox.needsYou.map((item) => item.row.id)).toEqual(["r2", "r1"]);
    expect(inbox.watching.map((r) => r.id)).toEqual(["r4", "r3"]);
  });
});

describe("factoryChiefStripLine", () => {
  it("counts what needs you and says when the Chief of Staff last looked", () => {
    expect(factoryChiefStripLine(3, 0, 2 * 60_000 + 5_000)).toBe("3 need you · checked 2 min ago");
    expect(factoryChiefStripLine(1, 0, 10_000)).toBe("1 needs you · checked just now");
    expect(factoryChiefStripLine(0, 0, 90 * 60_000)).toBe("Nothing needs you · checked 1 h ago");
    expect(factoryChiefStripLine(0, null, 0)).toBe("Nothing needs you · not checked yet");
  });
});

describe("Factory PRs the Chief of Staff watches (CoS 4)", () => {
  const watch = (phase: "in-review" | "waiting-for-review" | "merged" | "closed") => ({
    prWatch: { number: 9, url: "https://github.com/o/r/pull/9", phase, seen: { review: 0, reviewComment: 0, comment: 0 } },
  });

  it("the card's chip says where an open PR stands", () => {
    expect(factoryPrChip(row("r1", "done", null, watch("in-review")))).toBe("in review");
    expect(factoryPrChip(row("r1", "done", null, watch("waiting-for-review")))).toBe("waiting for review");
    // Not looked at yet, or ended: the card line says it, no chip.
    expect(factoryPrChip(row("r1", "done"))).toBeNull();
    expect(factoryPrChip(row("r1", "merged", null, watch("merged")))).toBeNull();
  });

  it("the strip counts the PRs in review", () => {
    const rows = [row("r1", "done", null, watch("in-review")), row("r2", "done", null, watch("waiting-for-review")), row("r3", "merged", null, watch("merged"))];
    expect(factoryPrsInReview(rows)).toBe(2);
    expect(factoryChiefStripLine(1, 0, 0, 2)).toBe("1 needs you · 2 PRs in review · checked just now");
    expect(factoryChiefStripLine(0, 0, 0, 1)).toBe("Nothing needs you · 1 PR in review · checked just now");
  });

  it("an open PR is watched with nothing to do, below what needs you", () => {
    const inbox = factoryChiefInbox([row("r1", "done", null, watch("in-review")), row("r2", "done")]);
    expect(inbox.watching.map((r) => r.id)).toEqual(["r1"]);
  });

  it("a note with no signal is in the log and is never an item", () => {
    const chief: FactoryChiefLog = { log: [{ at: 5, raised: false, text: "While you were away: 1 review." }], open: [] };
    const r = row("r1", "done", chief, watch("in-review"));
    expect(factoryChiefItems([r])).toEqual([]);
    expect(factoryChiefLog(r).map((e) => e.text)).toEqual(["While you were away: 1 review."]);
  });
});

describe("factoryChiefLog", () => {
  it("shows the run's notes newest first", () => {
    const chief: FactoryChiefLog = {
      log: [...paused(1_000).log, { at: 2_000, signal: "paused-at-cap", raised: false, text: "Aborted." }],
      open: [],
    };
    expect(factoryChiefLog(row("r1", "stopped", chief)).map((e) => e.text)).toEqual(["Aborted.", "Paused at the cap: spent $0.60 of $0.50."]);
  });
});

describe("Feedback batches (CoS 5)", () => {
  const item = (id: string, over: Partial<FactoryFeedbackItem> = {}): FactoryFeedbackItem => ({
    id,
    source: "pr-comment",
    author: "rev",
    counts: true,
    body: `says ${id}`,
    at: 0,
    status: "needs-you",
    batch: 1,
    label: "change",
    labelBy: "model",
    ...over,
  });
  const fed = (phase: "in-review" | "merged", feedback: FactoryFeedbackItem[]) => ({
    prWatch: { number: 9, url: "u", phase, seen: { review: 0, reviewComment: 0, comment: 0 }, feedback },
  });
  const raised: FactoryChiefLog = { log: [{ at: 5, signal: "feedback", raised: true, text: "Feedback batch 1 needs you (a review): 1 item, 1 change." }], open: ["feedback"] };

  it("a batch waiting on the user is one Needs-you item, gone once the PR ends", () => {
    const open = row("r1", "done", raised, fed("in-review", [item("comment:1"), item("comment:2", { counts: false, status: "new", batch: undefined })]));
    const [only] = factoryChiefItems([open]);
    expect(only.signal).toBe("feedback");
    expect(only.reason).toContain("Feedback batch 1");
    expect(factoryFeedbackNeedingYou(open).map((i) => i.id)).toEqual(["comment:1"]);
    expect(factoryFeedbackNotCounted(open).map((i) => i.id)).toEqual(["comment:2"]);
    expect(factoryChiefItems([row("r1", "merged", raised, fed("merged", [item("comment:1")]))])).toEqual([]);
  });

  it("an item says where it was left", () => {
    expect(factoryFeedbackPlace(item("line:1", { source: "review-comment", path: "src/a.rs", line: 3 }))).toBe("src/a.rs:3");
    expect(factoryFeedbackPlace(item("check:1", { source: "check" }))).toBe("CI");
    expect(factoryFeedbackPlace(item("review:1", { source: "review" }))).toBe("review");
  });
});

describe("Revision rounds (CoS 6)", () => {
  const item = (id: string, over: Partial<FactoryFeedbackItem> = {}): FactoryFeedbackItem => ({
    id,
    source: "pr-comment",
    author: "rev",
    counts: true,
    body: `says ${id}`,
    at: 0,
    status: "needs-you",
    batch: 1,
    label: "change",
    labelBy: "model",
    ...over,
  });
  const watched = (over: Partial<FactoryPrWatch> = {}) => ({
    prWatch: { number: 9, url: "u", phase: "in-review" as const, seen: { review: 0, reviewComment: 0, comment: 0 }, feedback: [item("line:1")], ...over },
  });
  const raised: FactoryChiefLog = { log: [{ at: 5, signal: "feedback", raised: true, text: "Feedback batch 1 needs you" }], open: ["feedback"] };
  const running = { round: 1, runId: "rd1", startedAt: 1, items: ["line:1"] };

  it("a feedback batch offers Start round, and it is open only with a change or nit waiting", () => {
    expect(factoryChiefItems([row("r1", "done", raised, watched())])[0].actions).toEqual(["start-round", "open-run"]);
    expect(factoryRoundBlocked(row("r1", "done", raised, watched()))).toBeNull();
    expect(factoryRoundBlocked(row("r1", "done", raised, watched({ feedback: [item("q", { label: "question" })] })))).toContain("No change, nit or accepted spec change");
    expect(factoryRoundBlocked(row("r1", "done", raised, watched({ feedback: [item("u", { unsure: "low confidence" })] })))).toContain("No change, nit or accepted spec change");
    // A spec change waits for Accept; once accepted, a round builds its Amendment (CoS 8).
    expect(factoryRoundBlocked(row("r1", "done", raised, watched({ feedback: [item("s", { label: "spec-change" })] })))).toContain("No change, nit or accepted");
    expect(factoryRoundBlocked(row("r1", "done", raised, watched({ feedback: [item("s", { label: "spec-change", amendment: 1 })] })))).toBeNull();
  });

  it("no round starts while one runs or after max_rounds", () => {
    expect(factoryRoundBlocked(row("r1", "done", raised, watched({ rounds: [running] })))).toBe("Round 1 is still running.");
    const ended = { ...running, ended: "pushed" as const };
    expect(factoryRoundBlocked(row("r1", "done", raised, watched({ rounds: [ended], maxRounds: 1 })))).toBe("The PR had all its 1 rounds.");
  });

  it("an item a round declined or did not address waits for the user again, with why", () => {
    const declined = item("line:1", { status: "declined", why: "public API" });
    const open = item("line:2", { status: "not-addressed" });
    const done = item("line:3", { status: "addressed" });
    const r = row("r1", "done", raised, watched({ feedback: [declined, open, done], rounds: [{ ...running, ended: "pushed" }] }));
    expect(factoryFeedbackNeedingYou(r).map((i) => i.id)).toEqual(["line:1", "line:2"]);
    expect(factoryRoundBlocked(r)).toBeNull();
  });

  it("the card's chip says the round and where the PR stands", () => {
    const chip = (over: Partial<FactoryPrWatch>) => factoryPrChip(row("r1", "done", null, watched(over)));
    expect(chip({ phase: "revising", rounds: [running] })).toBe("Round 1 of 3");
    expect(chip({ phase: "waiting-for-review", rounds: [{ ...running, ended: "pushed" }], maxRounds: 3 })).toBe("Round 1 of 3 · waiting for review");
    expect(chip({ phase: "needs-you", rounds: [{ ...running, ended: "needs-you" }], maxRounds: 2 })).toBe("Round 1 of 2 · needs you");
    expect(chip({ phase: "waiting-for-review" })).toBe("waiting for review");
    expect(chip({ phase: "out-of-rounds", rounds: [{ ...running, ended: "pushed" }], maxRounds: 1 })).toBe("Out of rounds");
  });

  it("the PR detail lists each round with what it did", () => {
    const lines = factoryRoundLines([
      { ...running, ended: "pushed", note: "Round 1 pushed 1a2b3c4d to factory/b of u" },
      { round: 2, runId: "rd2", startedAt: 2, items: ["a", "b"], ended: "needs-you", note: "The push was refused" },
      { round: 3, runId: "rd3", startedAt: 3, items: ["a"] },
    ]);
    expect(lines.map((l) => [l.state, l.line, l.tone])).toEqual([
      ["Pushed", "1 item · Round 1 pushed 1a2b3c4d to factory/b of u", "ok"],
      ["Needs you", "2 items · The push was refused", "bad"],
      ["Running", "1 item", "running"],
    ]);
  });
});

describe("Reply drafts (CoS 9)", () => {
  const item = (id: string, over: Partial<FactoryFeedbackItem> = {}): FactoryFeedbackItem => ({
    id,
    source: "review-comment",
    author: "rev",
    counts: true,
    body: `says ${id}`,
    path: "src/a.rs",
    line: 3,
    at: 0,
    status: "addressed",
    batch: 1,
    label: "change",
    labelBy: "model",
    ...over,
  });
  const raised: FactoryChiefLog = { log: [{ at: 5, signal: "feedback", raised: true, text: "Round 1 replies are drafted: check them and press Send all." }], open: ["feedback"] };
  const withDrafts = (feedback: FactoryFeedbackItem[], phase: FactoryPrWatch["phase"] = "waiting-for-review", summarySent?: number): FactoryRunRow =>
    row("r1", "done", raised, {
      prWatch: {
        number: 9,
        url: "u",
        phase,
        seen: { review: 0, reviewComment: 0, comment: 0 },
        feedback,
        rounds: [{ round: 1, runId: "x", startedAt: 0, items: ["line:1"], ended: "pushed", drafted: true, summary: "Round 1 renames x.", summarySent }],
      },
    });

  it("lists unsent replies, then the round summary; sent ones, CI and blanks are not drafts", () => {
    const drafts = factoryReplyDrafts(
      withDrafts([
        item("line:1", { reply: "Renamed." }),
        item("line:2", { reply: "Done.", replySent: 9 }),
        item("check:3", { source: "check", reply: "x" }),
        item("line:4", { reply: "  " }),
        item("line:5", { reply: "Mine.", counts: false }),
      ]),
    );
    expect(drafts).toEqual([
      { key: "line:1", meta: "To rev · src/a.rs:3 · addressed", text: "Renamed." },
      { key: "summary:1", meta: "Round 1 summary · on the PR", text: "Round 1 renames x." },
    ]);
  });

  it("an unsent draft keeps the feedback signal; once all are sent, or the PR ended, it is gone", () => {
    expect(factoryChiefItems([withDrafts([item("line:1", { reply: "Renamed." })])]).map((i) => i.signal)).toEqual(["feedback"]);
    expect(factoryChiefItems([withDrafts([item("line:1", { reply: "Renamed.", replySent: 9 })], "waiting-for-review", 9)])).toEqual([]);
    expect(factoryChiefItems([withDrafts([item("line:1", { reply: "Renamed." })], "merged")])).toEqual([]);
  });
});

describe("The Tasks Factory card's PR line (CoS 10)", () => {
  const watch = (over: Partial<FactoryPrWatch> = {}): FactoryPrWatch => ({ number: 9, url: "u", phase: "in-review", seen: { review: 0, reviewComment: 0, comment: 0 }, ...over });
  const waiting = (id: string, over: Partial<FactoryFeedbackItem> = {}): FactoryFeedbackItem => ({ id, source: "review", author: "rev", counts: true, body: "x", at: 0, status: "needs-you", batch: 1, ...over });

  it("says the PR, its round and phase, what needs you and what waits to be sent", () => {
    expect(factoryCardPrLine({ state: "done", prWatch: watch() })).toBe("PR #9 · in review");
    expect(
      factoryCardPrLine({
        state: "done",
        prWatch: watch({
          phase: "needs-you",
          rounds: [{ round: 2, runId: "a", startedAt: 0, items: [] }, { round: 1, runId: "b", startedAt: 0, items: [], ended: "pushed", summary: "s" }],
          feedback: [waiting("review:1"), waiting("review:2"), waiting("comment:3", { counts: false, status: "new" }), waiting("line:4", { status: "addressed", reply: "Done." })],
        }),
      }),
    ).toBe("PR #9 · Round 2 of 3 · needs you · 2 need you · 2 replies to send");
    expect(factoryCardPrLine({ state: "done", prWatch: watch({ phase: "out-of-rounds" }) })).toBe("PR #9 · Out of rounds");
  });

  it("is null without a watched open PR", () => {
    expect(factoryCardPrLine({ state: "done", prWatch: null })).toBeNull();
    expect(factoryCardPrLine({ state: "merged", prWatch: watch({ phase: "merged" }) })).toBeNull();
    expect(factoryCardPrLine({ state: "running", prWatch: watch() })).toBeNull();
  });
});
