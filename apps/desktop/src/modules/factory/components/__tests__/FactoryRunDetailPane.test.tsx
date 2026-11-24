import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FactoryRunDetailPane, type FactoryRunActions } from "@/modules/factory/components/FactoryRunDetailPane";
import type { FactoryRunRow } from "@/modules/factory/services/factory-run-list";

function row(over: Partial<FactoryRunRow>): FactoryRunRow {
  return {
    id: "run-1",
    projectId: "proj",
    repo: "o/r",
    issue: 7,
    title: "Copy button keeps old text",
    state: "running",
    group: "working",
    startedAt: 0,
    endedAt: null,
    spentUsd: 0.4,
    capUsd: 2,
    prUrl: null,
    output: null,
    progress: null,
    intake: null,
    ticket: { repo: "o/r", issue: 7, title: "Copy button keeps old text", body: "", account: "me", checkout: "/c", base: "main", implementer: "p1" },
    ...over,
  };
}

function actions(): FactoryRunActions {
  return {
    start: vi.fn(async () => "run-2"),
    raiseCap: vi.fn(async () => 4),
    abort: vi.fn(async () => {}),
    decide: vi.fn(async () => {}),
    openUrl: vi.fn(async () => {}),
    readIssue: vi.fn(async () => null),
  };
}

const filled = () => document.querySelectorAll(".rs-button--primary");

describe("FactoryRunDetailPane", () => {
  it("explains a recovery hold without offering actions that replay agents", () => {
    const a = actions();
    render(<FactoryRunDetailPane row={row({ state: "recovery-required", group: "needs-you", output: "Inspect retained worktree" })} now={0} actions={a} />);
    expect(screen.getByRole("heading", { name: "Recovery inspection" })).toBeTruthy();
    expect(screen.getByText(/Recovery-aware Resume is not available yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Raise cap" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(a.start).not.toHaveBeenCalled();
    expect(a.decide).not.toHaveBeenCalled();
  });

  it("shows the title, status word, time and spend of cap", () => {
    render(<FactoryRunDetailPane row={row({})} now={372_000} actions={actions()} />);
    expect(screen.getByRole("heading", { name: "#7 Copy button keeps old text" })).toBeTruthy();
    const meta = document.querySelector(".rs-dhead-meta")!.textContent!;
    expect(meta).toContain("Working");
    expect(meta).toContain("6:12");
    expect(meta).toContain("$0.40 of $2.00");
  });

  it("opens the issue on GitHub from the repo link", () => {
    const a = actions();
    render(<FactoryRunDetailPane row={row({})} now={0} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "o/r#7" }));
    expect(a.openUrl).toHaveBeenCalledWith("https://github.com/o/r/issues/7");
  });

  it("working: no filled button, Abort as an icon that aborts", async () => {
    const a = actions();
    render(<FactoryRunDetailPane row={row({})} now={0} actions={a} />);
    expect(filled()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Abort run" }));
    await waitFor(() => expect(a.abort).toHaveBeenCalledWith("run-1"));
  });

  it("check failed: the failing lines in a mono well, Full output expands, Try again starts it again", async () => {
    const a = actions();
    const output = ["RUN", " ✓ a", " FAIL b > adds", "AssertionError: 1 vs 2"].join("\n");
    render(<FactoryRunDetailPane row={row({ state: "check-failed", group: "needs-you", output })} now={0} actions={a} />);
    const well = document.querySelector(".fa-well")!;
    expect(well.textContent).toContain("FAIL b > adds");
    expect(well.textContent).not.toContain("RUN");
    expect(screen.getByText("Full output").closest("details")!.textContent).toContain("RUN");
    expect(filled()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(a.start).toHaveBeenCalledTimes(1));
    expect(vi.mocked(a.start).mock.calls[0][0].factory?.issue).toBe(7);
    expect(a.readIssue).toHaveBeenCalledWith("o/r", 7);
  });

  it("Try again reads the issue again, and starts from the stored copy when it cannot", async () => {
    const a = actions();
    vi.mocked(a.readIssue).mockResolvedValueOnce({ title: "Edited title", body: "Edited body" });
    render(<FactoryRunDetailPane row={row({ state: "error", group: "needs-you", output: "boom" })} now={0} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(a.start).toHaveBeenCalledTimes(1));
    expect(vi.mocked(a.start).mock.calls[0][0].factory).toMatchObject({ title: "Edited title", body: "Edited body", previousFailure: "boom" });

    vi.mocked(a.readIssue).mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(a.start).toHaveBeenCalledTimes(2));
    expect(vi.mocked(a.start).mock.calls[1][0].factory?.title).toBe("Copy button keeps old text");
  });

  it("paused at the cap: Raise cap is the one filled button", async () => {
    const a = actions();
    render(<FactoryRunDetailPane row={row({ state: "paused", group: "needs-you", spentUsd: 2.05 })} now={0} actions={a} />);
    expect(filled()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Raise cap" }));
    await waitFor(() => expect(a.raiseCap).toHaveBeenCalledWith("run-1"));
  });

  it("ready to review: a PR card, and Review PR opens it", async () => {
    const a = actions();
    const prUrl = "https://github.com/o/r/pull/9";
    render(<FactoryRunDetailPane row={row({ state: "done", group: "ready", prUrl })} now={0} actions={a} />);
    expect(screen.getByText("o/r#9")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review PR" }));
    await waitFor(() => expect(a.openUrl).toHaveBeenCalledWith(prUrl));
  });

  it("says why when an action fails, and lets you try once more", async () => {
    const a = actions();
    vi.mocked(a.raiseCap).mockRejectedValueOnce(new Error("cap locked"));
    render(<FactoryRunDetailPane row={row({ state: "paused", group: "needs-you" })} now={0} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Raise cap" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("cap locked"));
    expect((screen.getByRole("button", { name: "Raise cap" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("draws the run as a timeline: tries, time and cost from the record, the live step last", () => {
    const progress = {
      stage: "checking" as const,
      attempt: 1,
      maxAttempts: 2,
      steps: [
        { stage: "building" as const, attempt: 1, startedAt: 0, endedAt: 90_000, costUsd: 0.31 },
        { stage: "checking" as const, attempt: 1, startedAt: 90_000 },
      ],
    };
    render(<FactoryRunDetailPane row={row({ progress })} now={98_000} actions={actions()} />);
    const items = [...document.querySelectorAll(".fa-event")];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Build · try 1");
    expect(items[0].querySelector(".fa-event-span")?.textContent).toBe("1m 30s");
    expect(items[0].querySelector(".fa-event-meta")?.textContent).toBe("$0.31");
    expect(items[1].textContent).toContain("Check · try 1");
    expect(items[1].querySelector(".fa-event-meta")?.textContent).toBe("running");
    expect(items[1].querySelector(".fa-event-span")?.textContent).toBe("8s");
    expect(items[1].getAttribute("data-tone")).toBe("live");
    expect(screen.getByRole("button", { name: "Running for 1m 38s" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("marks a try failed only when the record shows it, and says where the run waits", () => {
    const progress = {
      stage: "checking" as const,
      attempt: 2,
      maxAttempts: 2,
      steps: [
        { stage: "checking" as const, attempt: 1, startedAt: 0, endedAt: 10_000 },
        { stage: "building" as const, attempt: 2, startedAt: 10_000, endedAt: 20_000 },
        { stage: "checking" as const, attempt: 2, startedAt: 20_000, endedAt: 30_000 },
      ],
    };
    render(<FactoryRunDetailPane row={row({ state: "check-failed", group: "needs-you", output: "FAIL x", progress })} now={40_000} actions={actions()} />);
    const items = [...document.querySelectorAll(".fa-event")].map((e) => e.textContent);
    expect(items[0]).toContain("Check · try 1 failed");
    expect(items[2]).toContain("Check · try 2 failed");
    expect(items[2]).toContain("retry limit reached");
  });

  it("shows the stage strip and one cell per try under it; the marks wear the strip's textures", () => {
    const progress = {
      stage: "building" as const,
      attempt: 2,
      maxAttempts: 3,
      steps: [
        { stage: "checking" as const, attempt: 1, startedAt: 0, endedAt: 10_000 },
        { stage: "building" as const, attempt: 2, startedAt: 10_000 },
      ],
    };
    render(<FactoryRunDetailPane row={row({ progress })} now={20_000} actions={actions()} />);
    const strip = screen.getByRole("list", { name: "Stages" });
    expect(strip.querySelector('[data-status="active"]')?.textContent).toBe("Build");
    expect([...document.querySelectorAll(".fa-try")].map((t) => t.getAttribute("data-status"))).toEqual(["failed", "active", "todo"]);
    expect(document.querySelector(".fa-tries")?.textContent).toContain("try 2 of 3");
    const marks = [...document.querySelectorAll(".fa-event-mark")];
    expect(marks.every((m) => m.querySelector("svg.fa-seg-svg"))).toBe(true);
    // The glyph stays on top of the texture: a done step still carries its check.
    expect(document.querySelector('.fa-event[data-tone="done"] .fa-event-mark svg.lucide')).not.toBeNull();
    expect(document.querySelector('.fa-event[data-tone="live"] .fa-seg-svg[data-front]')).not.toBeNull();
  });

  it("a run with one try allowed shows no try cells", () => {
    render(<FactoryRunDetailPane row={row({ progress: { stage: "building", attempt: 1, maxAttempts: 1, steps: [] } })} now={0} actions={actions()} />);
    expect(document.querySelector(".fa-tries")).toBeNull();
  });

  it("folds events older than the last eight behind +N earlier", () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({ stage: "building" as const, attempt: i + 1, startedAt: i * 1000, endedAt: i * 1000 + 500 }));
    render(<FactoryRunDetailPane row={row({ progress: { stage: "building", attempt: 10, maxAttempts: 10, steps } })} now={99_000} actions={actions()} />);
    expect(document.querySelectorAll(".fa-event")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "+2 earlier" }));
    expect(document.querySelectorAll(".fa-event")).toHaveLength(10);
  });

  it("heads the timeline with how the run went, counting only the failures it shows, and folds it", () => {
    const progress = {
      stage: "draft-pr" as const,
      attempt: 2,
      maxAttempts: 2,
      steps: [
        { stage: "checking" as const, attempt: 1, startedAt: 0, endedAt: 10_000 },
        { stage: "checking" as const, attempt: 2, startedAt: 10_000, endedAt: 20_000 },
      ],
    };
    render(<FactoryRunDetailPane row={row({ state: "done", group: "ready", endedAt: 92_000, progress })} now={500_000} actions={actions()} />);
    const head = screen.getByRole("button", { name: "Finished with 1 issue in 1m 32s" });
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll(".fa-event")).toHaveLength(0);
  });

  it("a run saved before steps were reported has no timeline and invents none", () => {
    render(<FactoryRunDetailPane row={row({ progress: null })} now={0} actions={actions()} />);
    expect(screen.queryByRole("region", { name: "Timeline" })).toBeNull();
  });

  it("puts the next step first: the sentence and its one filled button in one card", () => {
    render(<FactoryRunDetailPane row={row({ state: "check-failed", group: "needs-you" })} now={0} actions={actions()} />);
    const card = document.querySelector(".fa-next")!;
    expect(card.textContent).toContain("Next step");
    expect(card.querySelector(".rs-button--primary")?.textContent).toBe("Try again");
  });

  it("ready to review: the agent's summary, marked as not checked", () => {
    const progress = { stage: "draft-pr" as const, attempt: 1, maxAttempts: 2, steps: [], summary: "Added pluralize()" };
    render(<FactoryRunDetailPane row={row({ state: "done", group: "ready", prUrl: "https://github.com/o/r/pull/9", progress })} now={0} actions={actions()} />);
    const section = screen.getByRole("heading", { name: "Agent's summary" }).closest("section")!;
    expect(section.textContent).toMatch(/written by the agent, not verified/i);
    expect(section.textContent).toContain("Added pluralize()");
  });

  it("no summary block when the agent wrote none", () => {
    render(<FactoryRunDetailPane row={row({ state: "done", group: "ready", prUrl: "u" })} now={0} actions={actions()} />);
    expect(screen.queryByRole("heading", { name: "Agent's summary" })).toBeNull();
  });

  describe("intake (FI2)", () => {
    const question = { question: "Which text?", choices: ["Current", "Original"], recommended: "Current", why: "The ticket says current" };
    const waitingAnswers = row({
      state: "needs-answers",
      group: "needs-you",
      intake: { turns: [{ kind: "asked", questions: [question, { ...question, question: "Toast?", choices: ["Yes", "No"], recommended: "No" }], at: 5 }], approved: false },
    });

    it("asks the questions with the recommended choice picked, and sends the answers", async () => {
      const a = actions();
      render(<FactoryRunDetailPane row={waitingAnswers} now={0} actions={a} />);
      expect(screen.getByText(/has 2 questions/)).toBeTruthy();
      expect((screen.getAllByRole("radio", { name: /Current/ })[0] as HTMLInputElement).checked).toBe(true);
      expect(screen.getAllByText("Recommended")).toHaveLength(2);
      fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
      fireEvent.change(screen.getByLabelText("Note for question 1"), { target: { value: " keep it short " } });
      fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
      await waitFor(() =>
        expect(a.decide).toHaveBeenCalledWith("run-1", {
          kind: "answer",
          answers: [{ choice: "Current", note: "keep it short" }, { choice: "Yes", note: "" }],
        }),
      );
    });

    it("an own answer needs words before it can be sent", () => {
      render(<FactoryRunDetailPane row={waitingAnswers} now={0} actions={actions()} />);
      fireEvent.click(screen.getAllByRole("button", { name: "None of these, write my own" })[0]);
      expect((screen.getByRole("button", { name: "Send answers" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Note for question 1"), { target: { value: "Both" } });
      expect((screen.getByRole("button", { name: "Send answers" }) as HTMLButtonElement).disabled).toBe(false);
    });

    const waitingApproval = row({
      state: "needs-approval",
      group: "needs-you",
      intake: { turns: [{ kind: "spec", markdown: "# Spec: Copy (#7)\n\n## Goal\n\nCopy the current text.", live: false, at: 9 }], approved: false },
    });

    it("shows the spec and approves it as written", async () => {
      const a = actions();
      render(<FactoryRunDetailPane row={waitingApproval} now={0} actions={a} />);
      expect(screen.getByRole("heading", { name: "Goal" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(a.decide).toHaveBeenCalledWith("run-1", { kind: "approve" }));
    });

    it("approves an edit of the spec", async () => {
      const a = actions();
      render(<FactoryRunDetailPane row={waitingApproval} now={0} actions={a} />);
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.change(screen.getByLabelText("Edit the spec"), { target: { value: "# Spec\n\nNew" } });
      fireEvent.click(screen.getByRole("button", { name: "Approve my edit" }));
      await waitFor(() => expect(a.decide).toHaveBeenCalledWith("run-1", { kind: "approve", spec: "# Spec\n\nNew" }));
    });

    it("sends the spec back with a note, and shows why the engine refused", async () => {
      const a = actions();
      vi.mocked(a.decide).mockRejectedValueOnce(new Error("the run is not waiting for a spec to be approved"));
      render(<FactoryRunDetailPane row={waitingApproval} now={0} actions={a} />);
      fireEvent.click(screen.getByRole("button", { name: "Send back" }));
      const send = () => screen.getAllByRole("button", { name: "Send back" })[0] as HTMLButtonElement;
      expect(send().disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("What to change"), { target: { value: "Add an AC for empty text" } });
      fireEvent.click(send());
      await waitFor(() => expect(a.decide).toHaveBeenCalledWith("run-1", { kind: "send-back", note: "Add an AC for empty text" }));
      expect((await screen.findByRole("alert")).textContent).toContain("not waiting");
    });

    it("Brainstorm live opens an agent with the run's prompt on its checkout, and says why when it cannot", async () => {
      const a = { ...actions(), brainstorm: vi.fn<(prompt: string, checkout: string) => Promise<string | null>>(async () => "Open a workspace in Code mode first") };
      render(<FactoryRunDetailPane row={waitingApproval} now={0} actions={a} />);
      fireEvent.click(screen.getByRole("button", { name: "Brainstorm live" }));
      await waitFor(() => expect(a.brainstorm).toHaveBeenCalledTimes(1));
      const [prompt, checkout] = vi.mocked(a.brainstorm).mock.calls[0];
      expect(prompt).toContain('runId "run-1"');
      expect(prompt).toContain("The latest spec draft");
      expect(checkout).toBe("/c");
      expect((await screen.findByRole("alert")).textContent).toContain("Code mode");
    });

    it("no Brainstorm live where nothing can open a pane, nor on a run that is not waiting", () => {
      const { unmount } = render(<FactoryRunDetailPane row={waitingApproval} now={0} actions={actions()} />);
      expect(screen.queryByRole("button", { name: "Brainstorm live" })).toBeNull();
      unmount();
      render(<FactoryRunDetailPane row={row({})} now={0} actions={{ ...actions(), brainstorm: vi.fn(async () => null) }} />);
      expect(screen.queryByRole("button", { name: "Brainstorm live" })).toBeNull();
    });
  });
  describe("triage (FI3)", () => {
    const report = {
      size: "M" as const,
      readiness: {
        scope: "clear",
        dataModel: "clear",
        uxFlow: "partial",
        nonFunctional: "clear",
        integrations: "clear",
        edgeCases: "missing",
        constraints: "clear",
        terminology: "clear",
        completion: "clear",
      } as const,
      score: "red" as const,
      verdict: "refuse" as const,
      reason: "This asks for a new product, not a fix",
      summary: "s",
      files: ["src/copy.ts"],
    };
    const refused = row({
      state: "triage-blocked",
      group: "needs-you",
      intake: {
        turns: [],
        approved: false,
        triage: { report, duplicates: [], labels: ["bug"], notes: [], duplicatesAccepted: false, refusalOverridden: false, at: 5 },
      },
    });

    it("a refusal shows its reason, the nine ratings, and Continue anyway proceeds", async () => {
      const a = actions();
      render(<FactoryRunDetailPane row={refused} now={0} actions={a} />);
      expect(document.querySelector(".fa-sentence")!.textContent).toBe(
        "Triage advises not to build this ticket. This asks for a new product, not a fix. Continue anyway or abort.",
      );
      expect(screen.getByText("🔴 Not ready")).toBeTruthy();
      const ratings = [...document.querySelectorAll(".fa-readiness tr")].map((tr) => tr.textContent);
      expect(ratings).toHaveLength(9);
      expect(ratings).toContain("UX flowPartial");
      expect(ratings).toContain("Edge casesMissing");
      expect(screen.getByText("Labels: bug")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
      await waitFor(() => expect(a.decide).toHaveBeenCalledWith("run-1", { kind: "proceed" }));
      expect(screen.getByRole("button", { name: "Abort run" })).toBeTruthy();
    });

    it("duplicates link to the PR and the branch", () => {
      const a = actions();
      const dup = row({
        state: "triage-blocked",
        group: "needs-you",
        intake: {
          turns: [],
          approved: false,
          triage: {
            duplicates: [
              { kind: "pr", branch: "someone/copy", number: 12, url: "https://github.com/o/r/pull/12" },
              { kind: "branch", branch: "fix/7-copy" },
            ],
            labels: [],
            notes: ["could not list the branches on origin: timeout"],
            duplicatesAccepted: false,
            refusalOverridden: false,
            at: 5,
          },
        },
      });
      render(<FactoryRunDetailPane row={dup} now={0} actions={a} />);
      expect(document.querySelector(".fa-sentence")!.textContent).toContain("Work on this issue already exists");
      fireEvent.click(screen.getByRole("button", { name: "PR #12 (someone/copy)" }));
      expect(a.openUrl).toHaveBeenCalledWith("https://github.com/o/r/pull/12");
      fireEvent.click(screen.getByRole("button", { name: "Branch fix/7-copy" }));
      expect(a.openUrl).toHaveBeenCalledWith("https://github.com/o/r/tree/fix/7-copy");
      expect(screen.getByText("Not checked: could not list the branches on origin: timeout")).toBeTruthy();
      expect(screen.queryByText("🔴 Not ready")).toBeNull();
    });

    it("a triage that let the run go on is shown without Continue anyway", () => {
      const going = row({
        state: "needs-answers",
        group: "needs-you",
        intake: {
          turns: [{ kind: "asked", questions: [{ question: "Plain?", choices: ["Yes", "No"], recommended: "Yes", why: "" }], at: 6 }],
          approved: false,
          triage: { report: { ...report, verdict: "go" }, duplicates: [], labels: [], notes: [], duplicatesAccepted: false, refusalOverridden: false, at: 5 },
        },
      });
      render(<FactoryRunDetailPane row={going} now={0} actions={actions()} />);
      expect(screen.getByText("Go")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Continue anyway" })).toBeNull();
      expect(screen.getByRole("button", { name: "Send answers" })).toBeTruthy();
    });
  });

  it("a watched open PR has Find Slack thread, which says where the link was shared or that it was not; a merged one has none (CoS 12)", async () => {
    const prUrl = "https://github.com/o/r/pull/9";
    const watched = (phase: "waiting-for-review" | "merged") =>
      row({ state: "done", group: "ready", prUrl, prWatch: { number: 9, url: prUrl, phase, seen: { review: 0, reviewComment: 0, comment: 0 }, feedback: [] } });
    const a = { ...actions(), findSlackThread: vi.fn().mockResolvedValueOnce({ channel: "C1", channelName: "reviews", ts: "1.2", permalink: "https://x.slack.com/p" }).mockResolvedValueOnce(null) };
    const { unmount } = render(<FactoryRunDetailPane row={watched("waiting-for-review")} now={0} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Find Slack thread" }));
    expect(await screen.findByText("Found in #reviews")).toBeTruthy();
    expect(a.findSlackThread).toHaveBeenCalledWith("run-1");
    fireEvent.click(screen.getByRole("button", { name: "Find Slack thread" }));
    expect(await screen.findByText("No Slack thread shares this PR: no Slack message.")).toBeTruthy();
    unmount();
    render(<FactoryRunDetailPane row={watched("merged")} now={0} actions={a} />);
    expect(screen.queryByRole("button", { name: "Find Slack thread" })).toBeNull();
  });
});
