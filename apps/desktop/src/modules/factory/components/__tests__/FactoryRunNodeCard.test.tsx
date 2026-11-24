import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FactoryRunNodeCard } from "@/modules/factory/components/FactoryRunNodeCard";
import type { FactoryRunState } from "@/modules/factory/services/factory-run";
import type { FactoryGroupId, FactoryRunRow } from "@/modules/factory/services/factory-run-list";

const GROUP: Record<Exclude<FactoryRunState, "idle">, FactoryGroupId> = {
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

function row(state: Exclude<FactoryRunState, "idle">, over: Partial<FactoryRunRow> = {}): FactoryRunRow {
  return {
    id: "r",
    projectId: "p",
    repo: "o/r",
    issue: 6,
    title: "Exit lifecycle",
    state,
    group: GROUP[state],
    startedAt: 0,
    endedAt: null,
    spentUsd: 0.31,
    capUsd: 2,
    prUrl: null,
    output: null,
    progress: null,
    intake: null,
    ticket: { repo: "o/r", issue: 6, title: "Exit lifecycle", body: "", account: "me", checkout: "/c", base: "main", implementer: "p1" },
    ...over,
  };
}

const saved = { issue: 6, title: "Exit lifecycle" };

describe("a Factory Run as a canvas node (#146)", () => {
  it("names the button by the next step", () => {
    for (const [state, verb] of [["needs-answers", "Answer"], ["needs-approval", "Approve"], ["paused", "Raise cap"]] as const) {
      const { unmount } = render(<FactoryRunNodeCard row={row(state)} saved={saved} now={0} loading={false} onOpen={vi.fn()} />);
      expect(screen.getByRole("button", { name: verb })).toBeTruthy();
      unmount();
    }
  });

  it("shows title, sentence, the stages and time · cost, with no button while it works", () => {
    render(<FactoryRunNodeCard row={row("running")} saved={saved} now={42_000} loading={false} onOpen={vi.fn()} />);
    expect(screen.getByText("#6 Exit lifecycle")).toBeTruthy();
    expect(screen.getByText(/Waiting in line/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Stages" })).toBeTruthy();
    expect(screen.getByText("0:42 · $0.31")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gives only a run that needs you a button, and it opens the run", () => {
    const onOpen = vi.fn();
    render(<FactoryRunNodeCard row={row("check-failed")} saved={saved} now={0} loading={false} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("opens the run on a double-click", () => {
    const onOpen = vi.fn();
    render(<FactoryRunNodeCard row={row("done")} saved={saved} now={0} loading={false} onOpen={onOpen} />);
    expect(screen.queryByRole("button")).toBeNull();
    fireEvent.doubleClick(screen.getByText("#6 Exit lifecycle"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("says what it kept when the run cannot be found", () => {
    const { rerender } = render(<FactoryRunNodeCard row={null} saved={saved} now={0} loading onOpen={vi.fn()} />);
    expect(screen.getByText("Reading…")).toBeTruthy();
    rerender(<FactoryRunNodeCard row={null} saved={saved} now={0} loading={false} onOpen={vi.fn()} />);
    expect(screen.getByText("#6 Exit lifecycle")).toBeTruthy();
    expect(screen.getByText("No Factory run for this issue.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Stages" })).toBeNull();
  });
});
