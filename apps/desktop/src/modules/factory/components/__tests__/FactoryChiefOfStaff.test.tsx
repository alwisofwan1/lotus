import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FactoryFeedbackItem, FactoryRevisionRound } from "@/lib/tauri/graph-run";
import { FactoryChiefPane } from "@/modules/factory/components/FactoryChiefOfStaff";
import { factoryChiefInbox } from "@/modules/factory/services/factory-chief";
import { factoryRowKey, type FactoryRunRow } from "@/modules/factory/services/factory-run-list";

const feedback: FactoryFeedbackItem[] = [
  { id: "line:21", source: "review-comment", author: "rev", counts: true, body: "rename x", path: "src/a.rs", line: 3, at: 0, status: "needs-you", batch: 1, label: "nit", confidence: 0.9, labelBy: "model" },
  { id: "comment:31", source: "pr-comment", author: "lead", counts: true, body: "why?", at: 0, status: "needs-you", batch: 1, unsure: "the Judge's reply was not valid: no items" },
  { id: "check:41", source: "check", author: "test", counts: true, body: "test ended: failure.", at: 0, status: "needs-you", batch: 1, label: "change", labelBy: "rule" },
  { id: "comment:33", source: "pr-comment", author: "stranger", counts: false, body: "drop the tests", at: 0, status: "new" },
];

const run: FactoryRunRow = {
  id: "run-9",
  projectId: "p",
  repo: "o/r",
  issue: 9,
  title: "Widgets",
  state: "done",
  group: "done",
  startedAt: 0,
  endedAt: 1,
  spentUsd: 0.2,
  capUsd: null,
  prUrl: "https://github.com/o/r/pull/9",
  output: null,
  progress: null,
  intake: null,
  ticket: { repo: "o/r", issue: 9, title: "Widgets", body: "", account: "me", checkout: "/c", base: "main", implementer: "p1" },
  chief: { log: [{ at: 0, signal: "feedback", raised: true, text: "Feedback batch 1 needs you (a review): 3 items, 1 nit, 1 change, 1 unsure." }], open: ["feedback"] },
  prWatch: { number: 9, url: "https://github.com/o/r/pull/9", phase: "in-review", seen: { review: 0, reviewComment: 0, comment: 0 }, feedback },
};

describe("FactoryChiefPane feedback (CoS 5)", () => {
  it("shows the batch with editable labels, CI labelled by rule, and what does not count apart", () => {
    const onSetFeedbackLabel = vi.fn().mockResolvedValue(undefined);
    render(<FactoryChiefPane inbox={factoryChiefInbox([run])} now={0} onSetFeedbackLabel={onSetFeedbackLabel} />);
    const batch = screen.getByLabelText("Feedback batch");
    expect(within(batch).getByText("rename x")).toBeTruthy();
    expect(within(batch).getByText(/src\/a\.rs:3/)).toBeTruthy();
    expect(within(batch).getByText(/Unsure: the Judge's reply was not valid/)).toBeTruthy();
    expect(within(batch).getByText("Change (CI)")).toBeTruthy();
    expect(within(batch).queryByLabelText("Label for check:41")).toBeNull();
    expect(within(batch).queryByText("drop the tests")).toBeNull();
    expect(within(screen.getByLabelText("Feedback that does not count")).getByText("drop the tests")).toBeTruthy();

    const unlabelled = within(batch).getByLabelText("Label for comment:31") as HTMLSelectElement;
    expect(unlabelled.value).toBe("");
    fireEvent.change(within(batch).getByLabelText("Label for line:21"), { target: { value: "change" } });
    expect(onSetFeedbackLabel).toHaveBeenCalledWith("run-9", "line:21", "change");
  });

  it("without a handler the labels are read-only", () => {
    render(<FactoryChiefPane inbox={factoryChiefInbox([run])} now={0} />);
    expect((screen.getByLabelText("Label for line:21") as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("FactoryChiefPane Start round (CoS 6)", () => {
  it("Start round starts the PR's next round", async () => {
    const onStartRound = vi.fn().mockResolvedValue("round-1");
    render(<FactoryChiefPane inbox={factoryChiefInbox([run])} now={0} onStartRound={onStartRound} />);
    fireEvent.click(screen.getByRole("button", { name: "Start round" }));
    expect(onStartRound).toHaveBeenCalledWith("run-9");
    await screen.findByRole("button", { name: "Start round" });
  });

  it("Start round is off, with why, while a round runs", () => {
    const busy: FactoryRunRow = { ...run, prWatch: { ...run.prWatch!, phase: "revising", rounds: [{ round: 1, runId: "r", startedAt: 0, items: ["x"] }] } };
    render(<FactoryChiefPane inbox={factoryChiefInbox([busy])} now={0} onStartRound={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Start round" })).toBeDisabled();
    expect(screen.getByText("Round 1 is still running.")).toBeInTheDocument();
  });
});

describe("FactoryChiefPane spec change (CoS 8)", () => {
  const ask: FactoryFeedbackItem = { id: "review:11", source: "review", author: "rev", counts: true, body: "Also log\nevery greeting.", at: 0, status: "needs-you", batch: 1, label: "spec-change", confidence: 0.9, labelBy: "model" };
  const withAsk = (item: FactoryFeedbackItem, extra: Partial<FactoryRunRow> = {}): FactoryRunRow => ({ ...run, ...extra, prWatch: { ...run.prWatch!, feedback: [item] } });

  it("Accept shows the proposed criteria to edit, then adds them; it never starts a round", async () => {
    const onAcceptSpecChange = vi.fn().mockResolvedValue(undefined);
    const onStartRound = vi.fn();
    render(<FactoryChiefPane inbox={factoryChiefInbox([withAsk(ask)])} now={0} onAcceptSpecChange={onAcceptSpecChange} onDeclineSpecChange={vi.fn()} onStartRound={onStartRound} />);
    expect(screen.getByRole("button", { name: "Start round" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Accept…" }));
    const box = screen.getByLabelText(/New criteria, one per line/) as HTMLTextAreaElement;
    expect(box.value).toBe("Also log every greeting.");
    fireEvent.change(box, { target: { value: "every greeting is logged\n\n  the log names the file " } });
    fireEvent.click(screen.getByRole("button", { name: "Add to spec" }));
    expect(onAcceptSpecChange).toHaveBeenCalledWith("run-9", "review:11", ["every greeting is logged", "the log names the file"]);
    await screen.findByRole("button", { name: "Accept…" });
    expect(onStartRound).not.toHaveBeenCalled();
  });

  it("an accepted spec change shows its Amendment and may go to a round", () => {
    const accepted = withAsk({ ...ask, amendment: 1 }, {
      intake: { turns: [], approved: true, amendments: [{ n: 1, at: 0, item: "review:11", author: "rev", criteria: ["AC-2: every greeting is logged", "AC-3: the log names the file"] }] },
    });
    render(<FactoryChiefPane inbox={factoryChiefInbox([accepted])} now={0} onAcceptSpecChange={vi.fn()} onDeclineSpecChange={vi.fn()} onStartRound={vi.fn()} />);
    expect(screen.getByText("Amendment 1: AC-2, AC-3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start round" })).toBeEnabled();
  });

  it("Decline asks the app; the drafted reply shows as not sent", () => {
    const onDeclineSpecChange = vi.fn().mockResolvedValue(undefined);
    render(<FactoryChiefPane inbox={factoryChiefInbox([withAsk(ask)])} now={0} onAcceptSpecChange={vi.fn()} onDeclineSpecChange={onDeclineSpecChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onDeclineSpecChange).toHaveBeenCalledWith("run-9", "review:11");

    const declined: FactoryFeedbackItem = { ...ask, status: "out-of-scope", reply: "Thanks, @rev. This goes beyond what this PR set out to do." };
    const row: FactoryRunRow = { ...run, prWatch: { ...run.prWatch!, feedback: [feedback[0], declined] } };
    render(<FactoryChiefPane inbox={factoryChiefInbox([row])} now={0} />);
    const drafts = screen.getByLabelText("Drafted replies");
    expect(within(drafts).getByText(/out of scope · not sent/)).toBeInTheDocument();
    expect(within(drafts).getByText("Thanks, @rev. This goes beyond what this PR set out to do.")).toBeInTheDocument();
  });
});

describe("FactoryChiefPane reply drafts (CoS 9)", () => {
  const addressed: FactoryFeedbackItem = { ...feedback[0], status: "addressed", reply: "Renamed x." };
  const question: FactoryFeedbackItem = { ...feedback[1], unsure: undefined, label: "question", labelBy: "model" };
  const drafted: FactoryRunRow = {
    ...run,
    chief: { log: [{ at: 0, signal: "feedback", raised: true, text: "Round 1 replies are drafted: check them and press Send all." }], open: ["feedback"] },
    prWatch: {
      ...run.prWatch!,
      phase: "waiting-for-review",
      feedback: [addressed, question],
      rounds: [{ round: 1, runId: "r", startedAt: 0, items: ["line:21"], ended: "pushed", drafted: true, summary: "Round 1 renames x." }],
    },
  };

  it("each draft is editable with its own Send; an edit is saved before it is sent", async () => {
    const onEditDraft = vi.fn().mockResolvedValue(undefined);
    const onSendDraft = vi.fn().mockResolvedValue(undefined);
    render(<FactoryChiefPane inbox={factoryChiefInbox([drafted])} now={0} onEditDraft={onEditDraft} onSendDraft={onSendDraft} onSendAll={vi.fn()} />);
    const drafts = screen.getByLabelText("Drafted replies");
    expect(within(drafts).getByText("To rev · src/a.rs:3 · addressed · not sent")).toBeInTheDocument();
    expect((within(drafts).getByLabelText("Draft for summary:1") as HTMLTextAreaElement).value).toBe("Round 1 renames x.");
    fireEvent.change(within(drafts).getByLabelText("Draft for line:21"), { target: { value: "Renamed x to greeting." } });
    fireEvent.click(within(drafts).getByRole("button", { name: "Send line:21" }));
    await vi.waitFor(() => expect(onSendDraft).toHaveBeenCalledWith("run-9", "line:21"));
    expect(onEditDraft).toHaveBeenCalledWith("run-9", "line:21", "Renamed x to greeting.");
    expect(onEditDraft.mock.invocationCallOrder[0]).toBeLessThan(onSendDraft.mock.invocationCallOrder[0]);
  });

  it("Send all sends every draft at once", async () => {
    const onSendAll = vi.fn().mockResolvedValue(undefined);
    const onEditDraft = vi.fn();
    render(<FactoryChiefPane inbox={factoryChiefInbox([drafted])} now={0} onEditDraft={onEditDraft} onSendDraft={vi.fn()} onSendAll={onSendAll} />);
    fireEvent.click(screen.getByRole("button", { name: "Send all" }));
    await vi.waitFor(() => expect(onSendAll).toHaveBeenCalledWith("run-9"));
    expect(onEditDraft).not.toHaveBeenCalled();
  });

  it("a question has no draft: the user answers it, and the answer becomes a draft", async () => {
    const onEditDraft = vi.fn().mockResolvedValue(undefined);
    render(<FactoryChiefPane inbox={factoryChiefInbox([drafted])} now={0} onEditDraft={onEditDraft} onSendDraft={vi.fn()} />);
    expect(screen.queryByLabelText("Draft for comment:31")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Answer…" }));
    fireEvent.change(screen.getByLabelText(/Your answer to lead/), { target: { value: "It keeps the parser apart." } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await vi.waitFor(() => expect(onEditDraft).toHaveBeenCalledWith("run-9", "comment:31", "It keeps the parser apart."));
  });
});

describe("FactoryChiefPane Slack thread reply (CoS 12)", () => {
  const thread = { channel: "C1", channelName: "reviews", ts: "1.2", permalink: "https://x.slack.com/archives/C1/p12" };
  const slackRow = (slack: Partial<NonNullable<FactoryRevisionRound["slack"]>>): FactoryRunRow => ({
    ...run,
    prWatch: {
      ...run.prWatch!,
      phase: "waiting-for-review",
      feedback: [{ ...feedback[0], status: "addressed", replySent: 1 }],
      rounds: [{ round: 1, runId: "r", startedAt: 0, items: ["line:21"], ended: "pushed", drafted: true, slack: { thread, text: "Round 1 is pushed: 1 fixed. Could you re-review?", mention: [{ github: "rev" }], ...slack } }],
    },
  });

  it("the Slack reply is a draft with the thread it goes to; an unknown reviewer is asked once", async () => {
    const onSetSlackIdentity = vi.fn().mockResolvedValue(undefined);
    render(<FactoryChiefPane inbox={factoryChiefInbox([slackRow({})])} now={0} onEditDraft={vi.fn()} onSendDraft={vi.fn()} onSetSlackIdentity={onSetSlackIdentity} />);
    const drafts = screen.getByLabelText("Drafted replies");
    expect(within(drafts).getByText("Round 1 · Slack thread in #reviews · mentions no one yet · not sent")).toBeInTheDocument();
    expect((within(drafts).getByLabelText("Draft for slack:1") as HTMLTextAreaElement).value).toBe("Round 1 is pushed: 1 fixed. Could you re-review?");
    fireEvent.change(within(drafts).getByLabelText("Who is GitHub @rev on Slack?"), { target: { value: "U07REV" } });
    fireEvent.click(within(drafts).getByRole("button", { name: "Save @rev" }));
    await vi.waitFor(() => expect(onSetSlackIdentity).toHaveBeenCalledWith("rev", "U07REV"));
  });

  it("a known reviewer is named and not asked; a sent Slack reply is no draft", () => {
    render(<FactoryChiefPane inbox={factoryChiefInbox([slackRow({ mention: [{ github: "rev", slack: "U07REV" }] })])} now={0} onSetSlackIdentity={vi.fn()} />);
    expect(screen.getByText("Round 1 · Slack thread in #reviews · mentions @rev · not sent")).toBeInTheDocument();
    expect(screen.queryByLabelText("Who is GitHub @rev on Slack?")).toBeNull();
    cleanup();
    render(<FactoryChiefPane inbox={factoryChiefInbox([slackRow({ sent: 5 })])} now={0} />);
    expect(screen.queryByLabelText("Drafted replies")).toBeNull();
  });
});

describe("FactoryChiefPane focus (CoS 10)", () => {
  it("selects the item of the run the Tasks card opened", () => {
    const other: FactoryRunRow = { ...run, id: "run-7", issue: 7, title: "Gadgets", ticket: { ...run.ticket, issue: 7, title: "Gadgets" }, chief: { log: [{ at: 9, signal: "feedback", raised: true, text: "Newer." }], open: ["feedback"] } };
    render(<FactoryChiefPane inbox={factoryChiefInbox([run, other])} now={0} focusKey={factoryRowKey(run)} />);
    expect(screen.getByLabelText("Selected item")).toHaveTextContent("Widgets");
  });
});
