import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FactorySurface } from "@/modules/factory/components/FactorySurface";
import { groupFactoryRuns, type FactoryRunRow } from "@/modules/factory/services/factory-run-list";

function row(over: Partial<FactoryRunRow> & Pick<FactoryRunRow, "issue" | "group">): FactoryRunRow {
  return {
    id: `run-${over.issue}`,
    projectId: "p",
    repo: "o/r",
    title: `Issue ${over.issue}`,
    state: "running",
    startedAt: 0,
    endedAt: null,
    spentUsd: null,
    capUsd: null,
    prUrl: null,
    output: null,
    progress: null,
    intake: null,
    ticket: { repo: "o/r", issue: over.issue as number, title: `Issue ${over.issue}`, body: "", account: "me", checkout: "/c", base: "main", implementer: "p1" },
    ...over,
  };
}

/** A row of `repo`, its ticket included. */
function inRepo(issue: number, repo: string, over: Partial<FactoryRunRow> = {}): FactoryRunRow {
  const base = row({ issue, group: "working", ...over });
  return { ...base, repo, ticket: { ...base.ticket!, repo } };
}

function runs(rows: FactoryRunRow[], over: { loading?: boolean; error?: string | null } = {}) {
  return { rows, groups: groupFactoryRuns(rows), loading: over.loading ?? false, error: over.error ?? null };
}

describe("FactorySurface", () => {
  it("Runs and Board each filter by repo, with run counts, remembered per tab (#167)", () => {
    window.localStorage.clear();
    const all = runs([
      row({ issue: 1, group: "working" }),
      row({ issue: 2, group: "working" }),
      inRepo(3, "o/x"),
    ]);
    const names = () => screen.queryAllByText(/^#\d Issue \d$/).map((e) => e.textContent?.replace(/^#\d /, "")).sort();
    const { unmount } = render(<FactorySurface runs={all} now={0} />);
    const picker = screen.getByRole("combobox", { name: "Filter by repo" });
    expect([...(picker as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["All repos · 3", "o/r · 2", "o/x · 1"]);
    expect(names()).toEqual(["Issue 1", "Issue 2", "Issue 3"]);
    fireEvent.change(picker, { target: { value: "o/x" } });
    expect(names()).toEqual(["Issue 3"]);

    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(screen.getByRole("combobox", { name: "Filter by repo" })).toHaveValue("");
    expect(names()).toEqual(["Issue 1", "Issue 2", "Issue 3"]);
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    expect(names()).toEqual(["Issue 3"]);

    unmount();
    render(<FactorySurface runs={all} now={0} />);
    expect(screen.getByRole("combobox", { name: "Filter by repo" })).toHaveValue("o/x");
  });

  it("a group chip the picked repo has no runs in lets go, so the list never goes blank", () => {
    window.localStorage.clear();
    render(<FactorySurface runs={runs([inRepo(1, "o/r"), inRepo(2, "o/r", { group: "needs-you", state: "check-failed" }), inRepo(3, "o/x")])} now={0} />);
    fireEvent.click(screen.getByRole("button", { name: /^Needs you/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by repo" }), { target: { value: "o/x" } });
    expect(screen.getByRole("listitem", { name: /#3 / })).toBeTruthy();
  });

  it("opening a run the repo filter hides shows all repos again, so its row is in the list", () => {
    window.localStorage.clear();
    const actions = { start: vi.fn(async () => "x"), raiseCap: vi.fn(async () => 1), abort: vi.fn(async () => {}), decide: vi.fn(async () => {}), openUrl: vi.fn(async () => {}), readIssue: vi.fn(async () => null) };
    const all = runs([inRepo(1, "o/r"), inRepo(3, "o/x")]);
    const first = render(<FactorySurface runs={all} now={0} actions={actions} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by repo" }), { target: { value: "o/x" } });
    first.unmount();
    render(<FactorySurface runs={all} now={0} actions={actions} focusKey="factory:o/r#1" />);
    expect(screen.getByRole("heading", { level: 2, name: "#1 Issue 1" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Filter by repo" })).toHaveValue("");
    expect(screen.getByRole("listitem", { name: /#1 / })).toBeTruthy();
  });

  it("one repo needs no repo filter, and a remembered repo with no runs falls back to all", () => {
    window.localStorage.clear();
    const { unmount } = render(<FactorySurface runs={runs([row({ issue: 1, group: "working" })])} now={0} />);
    expect(screen.queryByRole("combobox", { name: "Filter by repo" })).toBeNull();
    unmount();
    const first = render(<FactorySurface runs={runs([inRepo(1, "o/r"), inRepo(2, "o/x")])} now={0} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by repo" }), { target: { value: "o/x" } });
    first.unmount();
    render(<FactorySurface runs={runs([inRepo(1, "o/r"), inRepo(4, "o/y")])} now={0} />);
    expect(screen.getByRole("combobox", { name: "Filter by repo" })).toHaveValue("");
    expect(screen.queryAllByText(/^#\d Issue \d$/).map((e) => e.textContent).sort()).toEqual(["#1 Issue 1", "#4 Issue 4"]);
  });

  it("shows the Factory title and separates work from Settings", () => {
    render(<FactorySurface runs={runs([])} now={0} />);
    expect(screen.getByRole("heading", { level: 1, name: "Factory" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Runs", "Board", "Chief of Staff", "Settings"]);
  });

  it("the Chief of Staff tab counts what needs you and opens its pane, where Raise cap is the user's click", async () => {
    const paused = row({
      issue: 4,
      group: "needs-you",
      state: "paused",
      chief: { log: [{ at: 0, signal: "paused-at-cap", raised: true, text: "Paused at the cap: spent $0.60 of $0.50." }], open: ["paused-at-cap"] },
    });
    const actions = { start: vi.fn(async () => "x"), raiseCap: vi.fn(async () => 1), abort: vi.fn(async () => {}), decide: vi.fn(async () => {}), openUrl: vi.fn(async () => {}), readIssue: vi.fn(async () => null) };
    render(<FactorySurface runs={runs([paused, row({ issue: 5, group: "working" })])} now={3 * 60_000} chiefCheckedAt={0} actions={actions} />);

    const chief = screen.getByRole("tab", { name: /^Chief of Staff1, 1 needs you · checked 3 min ago$/ });
    expect(chief.getAttribute("title")).toBe("1 needs you · checked 3 min ago");
    fireEvent.click(chief);
    const inbox = screen.getByLabelText("Chief of Staff inbox");
    expect(within(inbox).getByRole("button", { name: /#4 Issue 4.*spent \$0\.60 of \$0\.50/ })).toBeTruthy();
    expect(within(inbox).getByText("#5 Issue 5")).toBeTruthy();
    expect(actions.raiseCap).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByLabelText("Selected item")).getByRole("button", { name: "Raise cap" }));
    await vi.waitFor(() => expect(actions.raiseCap).toHaveBeenCalledWith("run-4"));
    expect(actions.abort).not.toHaveBeenCalled();
  });

  it("a stalled run offers Open worktree, and a waiting run's Open run opens it in Runs", async () => {
    const stalled = row({
      issue: 6,
      group: "working",
      state: "running",
      progress: { stage: "building", attempt: 1, maxAttempts: 2, steps: [{ stage: "building", attempt: 1, startedAt: 0 }] },
      chief: { log: [{ at: 30 * 60_000, signal: "stalled", raised: true, text: "Stalled 30 min in Building, no agent output yet." }], open: ["stalled"] },
    });
    const waiting = row({
      issue: 7,
      group: "needs-you",
      state: "needs-answers",
      chief: { log: [{ at: 0, signal: "waiting-on-you", raised: true, text: "Waiting for your answers to the spec agent's questions." }], open: ["waiting-on-you"] },
    });
    const actions = {
      start: vi.fn(async () => "x"),
      raiseCap: vi.fn(async () => 1),
      abort: vi.fn(async () => {}),
      decide: vi.fn(async () => {}),
      openUrl: vi.fn(async () => {}),
      readIssue: vi.fn(async () => null),
      openWorktree: vi.fn(async () => {}),
    };
    render(<FactorySurface runs={runs([stalled, waiting])} now={31 * 60_000} chiefCheckedAt={0} actions={actions} />);
    fireEvent.click(screen.getByRole("tab", { name: /Chief of Staff.*2 need you/ }));

    // Newest first: the stall was raised last.
    const detail = () => screen.getByLabelText("Selected item");
    expect(within(detail()).getAllByText("Stalled 30 min in Building, no agent output yet.")).toHaveLength(2);
    fireEvent.click(within(detail()).getByRole("button", { name: "Open worktree" }));
    await vi.waitFor(() => expect(actions.openWorktree).toHaveBeenCalledWith("run-6"));
    expect(actions.abort).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByLabelText("Chief of Staff inbox")).getByRole("button", { name: /#7 Issue 7/ }));
    fireEvent.click(within(detail()).getByRole("button", { name: "Open run" }));
    expect(screen.getByRole("tab", { name: "Runs" }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByLabelText("Run detail")).getAllByText(/Issue 7/).length).toBeGreaterThan(0);
  });

  it("shows no count or line on the tab where the Chief of Staff is not running", () => {
    render(<FactorySurface runs={runs([])} now={0} />);
    const chief = screen.getByRole("tab", { name: "Chief of Staff" });
    expect(chief.getAttribute("title")).toBeNull();
  });

  it("closes from the bar", () => {
    const onClose = vi.fn();
    render(<FactorySurface runs={runs([])} now={0} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close factory" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has no close button when nothing can close it", () => {
    render(<FactorySurface runs={runs([])} now={0} />);
    expect(screen.queryByRole("button", { name: "Close factory" })).toBeNull();
  });

  it("keeps the Done group closed until asked, and says how each PR ended (#147)", () => {
    const rows = [
      row({ issue: 1, group: "ready", state: "done", endedAt: 1 }),
      row({ issue: 2, group: "done", state: "merged", endedAt: 1, prUrl: "https://github.com/o/r/pull/12" }),
    ];
    render(<FactorySurface runs={runs(rows)} now={0} />);
    const toggle = screen.getByRole("button", { name: "Done · 1" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("#2 Issue 2")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/PR #12 merged/)).toBeTruthy();
  });

  it("groups runs as Needs you, Working, Ready to review", () => {
    const rows = [
      row({ issue: 1, group: "ready", state: "done", endedAt: 60_000 }),
      row({ issue: 2, group: "working" }),
      row({ issue: 3, group: "needs-you", state: "paused" }),
    ];
    render(<FactorySurface runs={runs(rows)} now={0} />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Needs you",
      "Working",
      "Ready to review",
    ]);
  });

  it("shows each run's issue number, title and elapsed time", () => {
    const rows = [row({ issue: 7, group: "working", title: "Copy button keeps old text", startedAt: 1_000 })];
    render(<FactorySurface runs={runs(rows)} now={373_000} />);
    const item = screen.getByRole("listitem", { name: /#7/ });
    expect(item.textContent).toContain("#7");
    expect(item.textContent).toContain("Copy button keeps old text");
    expect(item.textContent).toContain("6:12");
  });

  it("marks each run with its group for the colour dot", () => {
    render(<FactorySurface runs={runs([row({ issue: 3, group: "needs-you", state: "paused" })])} now={0} />);
    const glyph = screen.getByRole("listitem", { name: /#3/ }).querySelector(".fa-glyph");
    expect(glyph?.getAttribute("data-group")).toBe("needs-you");
  });

  it("says so when there are no runs", () => {
    render(<FactorySurface runs={runs([])} now={0} />);
    expect(screen.getByText(/no factory runs yet/i)).toBeTruthy();
  });

  it("shows loading rows while the first read runs", () => {
    render(<FactorySurface runs={runs([], { loading: true })} now={0} />);
    expect(screen.getByLabelText("Loading runs").getAttribute("aria-busy")).toBe("true");
  });

  it("shows why a read failed, and keeps the rows", () => {
    render(<FactorySurface runs={runs([row({ issue: 1, group: "working" })], { error: "db locked" })} now={0} />);
    expect(screen.getByRole("alert").textContent).toContain("db locked");
    expect(screen.getByRole("listitem", { name: /#1/ })).toBeTruthy();
  });

  it("maps a previously persisted Insights tab to Runs instead of a dead-end stub", () => {
    render(<FactorySurface runs={runs([row({ issue: 1, group: "working" })])} now={0} tab="insights" />);
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(within(screen.getByRole("list", { name: /needs you|working/i })).getAllByRole("listitem")).toHaveLength(1);
  });

  describe("opening a run", () => {
    const actions = { start: vi.fn(async () => "x"), raiseCap: vi.fn(async () => 1), abort: vi.fn(async () => {}), decide: vi.fn(async () => {}), openUrl: vi.fn(async () => {}), readIssue: vi.fn(async () => null) };
    const three = () => [
      row({ issue: 3, group: "needs-you", state: "paused", startedAt: 3 }),
      row({ issue: 2, group: "working", startedAt: 2 }),
      row({ issue: 1, group: "working", startedAt: 1 }),
    ];
    const openButton = (issue: number) => screen.getByRole("listitem", { name: new RegExp(`#${issue} `) }).querySelector<HTMLButtonElement>("button.rs-row-open")!;

    it("shows a run's detail when you click it", () => {
      render(<FactorySurface runs={runs(three())} now={0} actions={actions} />);
      expect(screen.queryByRole("heading", { level: 2, name: /#2 Issue 2/ })).toBeNull();
      fireEvent.click(openButton(2));
      expect(screen.getByRole("heading", { level: 2, name: "#2 Issue 2" })).toBeTruthy();
    });

    it("puts a line to drag between the list and the run only while a run is open", () => {
      render(<FactorySurface runs={runs(three())} now={0} actions={actions} />);
      expect(screen.queryByRole("separator", { name: "Resize run detail" })).toBeNull();
      fireEvent.click(openButton(2));
      expect(screen.getByRole("separator", { name: "Resize run detail" })).toBeTruthy();
    });

    it("closes the run with its close button or Esc, but not Esc in a field", () => {
      const heading = () => screen.queryByRole("heading", { level: 2, name: "#2 Issue 2" });
      render(<FactorySurface runs={runs(three())} now={0} actions={actions} />);
      fireEvent.click(openButton(2));
      fireEvent.click(screen.getByRole("button", { name: "Close run detail (Esc)" }));
      expect(heading()).toBeNull();
      expect(screen.queryByRole("separator")).toBeNull();

      fireEvent.click(openButton(2));
      const field = document.createElement("textarea");
      document.body.append(field);
      fireEvent.keyDown(field, { key: "Escape" });
      expect(heading()).toBeTruthy();
      field.remove();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(heading()).toBeNull();
    });

    it("moves through the runs with the arrow keys, across groups, and opens with Enter", () => {
      render(<FactorySurface runs={runs(three())} now={0} actions={actions} />);
      openButton(3).focus();
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(openButton(2));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(openButton(1));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(openButton(1));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      fireEvent.keyDown(document.activeElement!, { key: "Enter" });
      expect(screen.getByRole("heading", { level: 2, name: "#2 Issue 2" })).toBeTruthy();
    });

    it("follows the issue to its new run after Try again", () => {
      const { rerender } = render(<FactorySurface runs={runs([row({ issue: 4, group: "needs-you", state: "check-failed" })])} now={0} actions={actions} />);
      fireEvent.click(openButton(4));
      rerender(<FactorySurface runs={runs([row({ id: "run-4b", issue: 4, group: "working" })])} now={0} actions={actions} />);
      expect(screen.getByRole("heading", { level: 2, name: "#4 Issue 4" })).toBeTruthy();
      expect(document.querySelector(".fa-detail .fa-status")!.textContent).toBe("Working");
    });

    it("a Needs-you row carries its own verb, and a chip narrows the list to its group", () => {
      render(<FactorySurface runs={runs([row({ issue: 4, group: "needs-you", state: "check-failed" }), row({ id: "r5", issue: 5, group: "working" })])} now={0} actions={actions} />);
      const failing = screen.getByRole("listitem", { name: /#4 / });
      fireEvent.click(within(failing).getByRole("button", { name: "See why" }));
      expect(screen.getByRole("heading", { level: 2, name: "#4 Issue 4" })).toBeTruthy();
      const chip = screen.getByRole("button", { name: /^Working/ });
      fireEvent.click(chip);
      expect(chip.getAttribute("aria-pressed")).toBe("true");
      expect(screen.queryByRole("listitem", { name: /#4 / })).toBeNull();
      expect(screen.getByRole("listitem", { name: /#5 / })).toBeTruthy();
      fireEvent.click(chip);
      expect(screen.getByRole("listitem", { name: /#4 / })).toBeTruthy();
    });

    it("rows are not openable without actions", () => {
      render(<FactorySurface runs={runs(three())} now={0} />);
      expect(within(screen.getByRole("listitem", { name: /#2 / })).queryByRole("button")).toBeNull();
    });
  });

  it("a working row says its stage and try", () => {
    const progress = { stage: "building" as const, attempt: 2, maxAttempts: 2, steps: [] };
    render(<FactorySurface runs={runs([row({ issue: 9, group: "working", progress })])} now={0} />);
    expect(screen.getByRole("listitem", { name: /#9 / }).textContent).toContain("Building · try 2 of 2");
  });

  describe("Board", () => {
    const actions = { start: vi.fn(async () => "x"), raiseCap: vi.fn(async () => 1), abort: vi.fn(async () => {}), decide: vi.fn(async () => {}), openUrl: vi.fn(async () => {}), readIssue: vi.fn(async () => null) };
    const at = (stage: "worktree" | "building" | "checking" | "draft-pr") => ({ stage, attempt: 1, maxAttempts: 2, steps: [] });
    const board = () => [
      row({ issue: 1, group: "working", progress: at("building"), startedAt: 0, spentUsd: 0.31 }),
      row({ issue: 2, group: "working", progress: at("checking") }),
      row({ issue: 3, group: "needs-you", state: "check-failed", progress: at("checking") }),
      row({ issue: 4, group: "ready", state: "done", progress: at("draft-pr"), endedAt: 60_000 }),
      row({ issue: 5, group: "working" }),
    ];
    const column = (name: string) => screen.getByRole("list", { name });
    const cards = (name: string) => [...column(name).querySelectorAll(":scope > li")];
    const card = (issue: number) => screen.getByRole("listitem", { name: new RegExp(`#${issue} `) });

    it("puts each run in the column of where it is", () => {
      render(<FactorySurface runs={runs(board())} now={30_000} tab="board" />);
      const issues = (name: string) => cards(name).map((li) => li.getAttribute("aria-label"));
      expect(issues("Queued")).toEqual(["#5 Issue 5"]);
      expect(screen.queryByRole("list", { name: "Done" })).toBeNull();
      expect(issues("Building")).toEqual(["#1 Issue 1"]);
      expect(issues("Checking")).toEqual(["#2 Issue 2"]);
      expect(issues("Needs you")).toEqual(["#3 Issue 3"]);
      expect(issues("Ready to review")).toEqual(["#4 Issue 4"]);
    });

    it("a card shows the bar, the status line, and time · cost", () => {
      render(<FactorySurface runs={runs(board())} now={30_000} tab="board" />);
      const c = card(1);
      expect([...c.querySelectorAll(".fa-bar-seg")].map((s) => s.getAttribute("data-status"))).toEqual(["done", "done", "done", "active", "todo", "todo", "todo"]);
      expect(c.textContent).toContain("Building · try 1 of 2");
      expect(c.textContent).toContain("0:30 · $0.31");
    });

    it("a card carries the same verb as its Runs row; any card opens the detail", () => {
      render(<FactorySurface runs={runs(board())} now={0} actions={actions} tab="board" />);
      expect(within(card(3)).getByRole("button", { name: "See why" })).toBeTruthy();
      expect(within(card(2)).queryByRole("button", { name: "See why" })).toBeNull();
      fireEvent.click(within(card(2)).getByRole("button", { name: /#2 Issue 2/ }));
      expect(screen.getByRole("heading", { level: 2, name: "#2 Issue 2" })).toBeTruthy();
      fireEvent.click(within(card(3)).getByRole("button", { name: "See why" }));
      expect(screen.getByRole("heading", { level: 2, name: "#3 Issue 3" })).toBeTruthy();
    });

    it("an empty column folds to a rail and Done opens on click", () => {
      render(<FactorySurface runs={runs([...board(), row({ issue: 6, group: "done", state: "merged" })])} now={0} tab="board" />);
      expect(screen.queryByRole("list", { name: "Done" })).toBeNull();
      fireEvent.click(document.querySelector("button.fa-rail[data-column=done]")!);
      expect(cards("Done")).toHaveLength(1);
    });

    it("cards move on their own when a run's stage changes", () => {
      const { rerender } = render(<FactorySurface runs={runs([row({ issue: 1, group: "working", progress: at("building") })])} now={0} tab="board" />);
      expect(cards("Building")).toHaveLength(1);
      rerender(<FactorySurface runs={runs([row({ issue: 1, group: "working", progress: at("checking") })])} now={0} tab="board" />);
      expect(screen.queryByRole("list", { name: "Building" })).toBeNull();
      expect(cards("Checking")).toHaveLength(1);
    });

    it("the tab is the caller's to keep: it reports a change and shows what it is given", () => {
      const onTabChange = vi.fn();
      render(<FactorySurface runs={runs(board())} now={0} tab="board" onTabChange={onTabChange} />);
      expect(screen.getByRole("tab", { name: "Board" }).getAttribute("aria-selected")).toBe("true");
      fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
      expect(onTabChange).toHaveBeenCalledWith("runs");
    });
  });

  it("opens the run it is pointed at, from the issue panel", () => {
    const actions = { start: vi.fn(async () => "x"), raiseCap: vi.fn(async () => 1), abort: vi.fn(async () => {}), decide: vi.fn(async () => {}), openUrl: vi.fn(async () => {}), readIssue: vi.fn(async () => null) };
    const rows = [row({ issue: 1, group: "working" }), row({ issue: 2, group: "working" })];
    render(<FactorySurface runs={runs(rows)} now={0} actions={actions} focusKey="factory:o/r#2" />);
    expect(screen.getByRole("heading", { level: 2, name: "#2 Issue 2" })).toBeTruthy();
  });

  describe("New run", () => {
    const newRun = {
      repos: [{ id: "s1", repo: "o/r", account: "me", name: "o/r" }],
      issues: () => [{ number: 1, title: "Fix it" }],
      presets: vi.fn(async () => [{ id: "p1", name: "Claude" }]),
      start: vi.fn(async () => []),
    };

    it("the bar's New run opens the sheet", () => {
      render(<FactorySurface runs={runs([row({ issue: 5, group: "working" })])} now={0} newRun={newRun} />);
      fireEvent.click(screen.getByRole("button", { name: "New run" }));
      expect(screen.getByRole("dialog", { name: "New run" })).toBeTruthy();
    });

    it("with no runs, Start your first run opens it", () => {
      render(<FactorySurface runs={runs([])} now={0} newRun={newRun} />);
      fireEvent.click(screen.getByRole("button", { name: "Start your first run" }));
      expect(screen.getByRole("dialog", { name: "New run" })).toBeTruthy();
    });

    it("a caller's request opens the sheet once per value, also on mount", () => {
      const { rerender } = render(<FactorySurface runs={runs([])} now={0} newRun={newRun} newRunRequest={1} />);
      expect(screen.getByRole("dialog", { name: "New run" })).toBeTruthy();
      fireEvent.click(within(screen.getByRole("dialog", { name: "New run" })).getByRole("button", { name: "Close" }));
      rerender(<FactorySurface runs={runs([])} now={0} newRun={newRun} newRunRequest={1} />);
      expect(screen.queryByRole("dialog", { name: "New run" })).toBeNull();
      rerender(<FactorySurface runs={runs([])} now={0} newRun={newRun} newRunRequest={2} />);
      expect(screen.getByRole("dialog", { name: "New run" })).toBeTruthy();
    });

    it("no New run without a source", () => {
      render(<FactorySurface runs={runs([])} now={0} />);
      expect(screen.queryByRole("button", { name: "New run" })).toBeNull();
    });

    it("with no runs and no New run, Open Tasks is the way out", () => {
      const onOpenTasks = vi.fn();
      render(<FactorySurface runs={runs([])} now={0} onOpenTasks={onOpenTasks} />);
      expect(screen.queryByRole("button", { name: "Start your first run" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Open Tasks" }));
      expect(onOpenTasks).toHaveBeenCalledTimes(1);
    });

    it("Settings without a ticket source offers Open Tasks", () => {
      const onOpenTasks = vi.fn();
      render(<FactorySurface runs={runs([])} now={0} tab="agents" onOpenTasks={onOpenTasks} />);
      expect(screen.getByText("Add a GitHub ticket source in Tasks to set up a factory.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open Tasks" }));
      expect(onOpenTasks).toHaveBeenCalledTimes(1);
    });
  });
});
