import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ForkMarker, MessageEditor, took, TurnActionsContext, TurnFoot, UserFoot, type TurnActions } from "../ChatTurnActions";

const end = { index: 2, endedAt: Date.UTC(2026, 10, 7, 9, 42), durationMs: 41_000, costUsd: 0.08, forkable: true };

function withActions(ui: React.ReactNode, overrides: Partial<TurnActions> = {}) {
  const actions: TurnActions = { quote: vi.fn(), fork: vi.fn(async () => {}), open: vi.fn(), toWorktree: vi.fn(async () => {}), edit: vi.fn(async () => {}), billed: false, ...overrides };
  render(<TurnActionsContext.Provider value={actions}>{ui}</TurnActionsContext.Provider>);
  return actions;
}

describe("your message's actions", () => {
  it("edits only where the agent can, and says why not", () => {
    const onEdit = vi.fn();
    withActions(<UserFoot text="hi" at={Date.UTC(2026, 10, 7, 9, 42)} edit="Wait for the reply" onEdit={onEdit} />, { edit: vi.fn(async () => {}) });
    fireEvent.click(screen.getByRole("button", { name: "Wait for the reply" }));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("opens the editor from Edit, and a runner without edit shows why", () => {
    const onEdit = vi.fn();
    const { unmount } = render(
      <TurnActionsContext.Provider value={{ quote: vi.fn(), fork: vi.fn(), open: vi.fn(), toWorktree: vi.fn(), billed: false, edit: vi.fn(async () => {}), branches: true }}>
        <UserFoot text="hi" at={0} edit onEdit={onEdit} />
      </TurnActionsContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalled();
    unmount();
    // An agent that cannot branch (Antigravity) edits only the first message: that starts a fresh session.
    withActions(<UserFoot text="hi" at={0} edit onEdit={onEdit} />);
    expect(screen.getByRole("button", { name: "This agent can only edit its first message" }).getAttribute("aria-disabled")).toBe("true");
    cleanup();
    withActions(<UserFoot text="hi" at={0} edit first onEdit={onEdit} />);
    expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-disabled")).toBe("false");
  });

  it("sends the changed words on ⌘↵, never the unchanged ones, and Esc puts the message back", async () => {
    const onSend = vi.fn(async () => {});
    const onCancel = vi.fn();
    render(<MessageEditor initial="fix it" onCancel={onCancel} onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Edit your message" });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "fix it properly" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("fix it properly");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("keeps the editor open with the error when sending fails", async () => {
    render(<MessageEditor initial="a" onCancel={vi.fn()} onSend={vi.fn(async () => Promise.reject("wait for the reply to finish"))} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("wait for the reply to finish");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("b");
  });
});

describe("turn actions", () => {
  it("quotes the reply into the composer, forks from the row, and shows the turn's time, duration and cost", async () => {
    const actions = withActions(<TurnFoot text={"Line one\nLine two"} turnId="u2" end={end} />);
    fireEvent.click(screen.getByRole("button", { name: "Quote in reply" }));
    expect(actions.quote).toHaveBeenCalledWith("Line one\nLine two");
    expect(screen.getByText("41s")).toBeTruthy();
    expect(screen.getByText("$0.08").getAttribute("title")).toMatch(/Not charged/);
    fireEvent.click(screen.getByRole("button", { name: "Fork from here" }));
    expect(actions.fork).toHaveBeenCalledWith("u2");
    await waitFor(() => expect(screen.getByRole("button", { name: "Fork from here" }).getAttribute("aria-disabled")).toBe("false"));
  });

  it("does not fork a turn without a fork point, and says why in its label", () => {
    const actions = withActions(<TurnFoot text="x" turnId="u1" end={{ ...end, forkable: false, costUsd: null }} />);
    fireEvent.click(screen.getByRole("button", { name: "Can't fork: older turn" }));
    expect(actions.fork).not.toHaveBeenCalled();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("says when a fork fails, under the reply", async () => {
    withActions(<TurnFoot text="x" turnId="u1" end={end} />, { fork: vi.fn(async () => Promise.reject("that turn has not finished")) });
    fireEvent.click(screen.getByRole("button", { name: "Fork from here" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Fork failed: that turn has not finished");
  });

  it("links a fork back to its original and moves a fresh fork into a worktree at its turn", async () => {
    const actions = withActions(<ForkMarker fromThreadId="o" fromTitle="Fix the flaky test" turn={2} worktree={null} canMove />);
    fireEvent.click(screen.getByRole("button", { name: "Fix the flaky test" }));
    expect(actions.open).toHaveBeenCalledWith("o");
    fireEvent.click(screen.getByRole("button", { name: "Use a worktree at turn 2" }));
    expect(actions.toWorktree).toHaveBeenCalledOnce();
  });

  it("offers no move once the fork has worked, says where a moved one lives, and shows a failed move", async () => {
    const { unmount } = render(<ForkMarker fromThreadId="o" fromTitle="X" turn={2} worktree={null} canMove={false} />);
    expect(screen.queryByRole("button", { name: /worktree/ })).toBeNull();
    unmount();
    withActions(<ForkMarker fromThreadId="o" fromTitle="X" turn={2} worktree="lotus/f-x-a1b2c3" canMove={false} />);
    expect(screen.getByText("lotus/f-x-a1b2c3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use a worktree/ })).toBeNull();
  });

  it("says why a move failed and offers to try again", async () => {
    withActions(<ForkMarker fromThreadId="o" fromTitle="X" turn={2} worktree={null} canMove />, {
      toWorktree: vi.fn(async () => Promise.reject("the folder is not in a git repository")),
    });
    fireEvent.click(screen.getByRole("button", { name: "Use a worktree at turn 2" }));
    expect((await screen.findByRole("alert")).textContent).toBe("the folder is not in a git repository");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("formats durations", () => {
    expect([took(8_000), took(134_000), took(3_780_000)]).toEqual(["8s", "2m 14s", "1h 3m"]);
  });
});
