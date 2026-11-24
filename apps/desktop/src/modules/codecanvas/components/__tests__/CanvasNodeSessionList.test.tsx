import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasNodeSessionList } from "../sessions/CanvasNodeSessionList";
import type { CanvasSessionRecord } from "../../services/session-record";

const NOW = new Date(2026, 10, 13, 15, 0).getTime();

function session(overrides: Partial<CanvasSessionRecord> & { id: string }): CanvasSessionRecord {
  return {
    projectId: "cp_1",
    nodeId: "agent-1",
    runner: "claude",
    cwd: "/repos/demo",
    title: `Session ${overrides.id}`,
    status: "resumable",
    origin: "manual",
    turnCount: 3,
    lastActivityAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function renderList(props: Partial<React.ComponentProps<typeof CanvasNodeSessionList>> = {}) {
  return render(
    <CanvasNodeSessionList
      sessions={[]}
      agentName="Rei"
      now={NOW}
      onTogglePinned={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

const row = (name: string) => screen.getByRole("option", { name });

describe("CanvasNodeSessionList", () => {
  it("is named for the node it belongs to", () => {
    renderList();
    expect(screen.getByRole("dialog", { name: "Rei's sessions" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search Rei's sessions")).toBeInTheDocument();
  });

  it("says the node has no sessions rather than showing an empty box", () => {
    renderList();
    expect(screen.getByText("No sessions on this node yet.")).toBeInTheDocument();
  });

  // Graph-run conversations are hidden from the project list, never from their own node's.
  it("lists every conversation on this node, including machine-started ones", () => {
    renderList({ sessions: [session({ id: "a" }), session({ id: "b", origin: "graph-run" })] });
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("marks the conversation the node is currently in, and does not offer to switch to it", () => {
    const onSelect = vi.fn();
    renderList({ sessions: [session({ id: "a" })], activeSessionId: "a", onSelect });
    const current = row("Session a");
    expect(current).toHaveAttribute("aria-current", "true");
    expect(within(current).getByText("Current")).toBeInTheDocument();
    fireEvent.click(current);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("switches the node to another conversation", () => {
    const onSelect = vi.fn();
    const other = session({ id: "b" });
    renderList({ sessions: [session({ id: "a" }), other], activeSessionId: "a", onSelect });
    fireEvent.click(row("Session b"));
    expect(onSelect).toHaveBeenCalledWith(other);
  });

  it("cannot switch to a conversation the CLI has lost", () => {
    const onSelect = vi.fn();
    renderList({ sessions: [session({ id: "a", status: "dead" })], onSelect });
    fireEvent.click(row("Session a"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("pins and unpins from the row's menu", () => {
    const onTogglePinned = vi.fn();
    const pinned = session({ id: "a", pinned: true });
    renderList({ sessions: [pinned], onTogglePinned });
    expect(within(row("Session a")).getByLabelText("Pinned")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Options for Session a" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Unpin/ }));
    expect(onTogglePinned).toHaveBeenCalledWith(pinned, false);
  });

  it("starts a fresh conversation on the same node, by click or ⌘N", () => {
    const onNewSession = vi.fn();
    renderList({ onNewSession, onSelect: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /New conversation/ }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "n", metaKey: true });
    expect(onNewSession).toHaveBeenCalledTimes(2);
  });

  it("refuses every action while a relaunch is in flight", () => {
    const onSelect = vi.fn();
    renderList({ sessions: [session({ id: "a" })], onSelect, onNewSession: vi.fn(), busy: true });
    expect(screen.queryByRole("button", { name: /New conversation/ })).not.toBeInTheDocument();
    fireEvent.click(row("Session a"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hides switching and starting when the node cannot be relaunched", () => {
    renderList({ sessions: [session({ id: "a" })] });
    expect(screen.queryByRole("button", { name: /New conversation/ })).not.toBeInTheDocument();
    expect(row("Session a")).toHaveAttribute("aria-disabled", "true");
  });

  it("marks the current conversation amber and says what the agent is waiting on", () => {
    renderList({
      sessions: [session({ id: "a", status: "live" }), session({ id: "b" })],
      activeSessionId: "a",
      needsYou: { headline: "Apply edit to redirect.ts?" },
    });
    expect(row("Session a")).toHaveAttribute("data-needs-you");
    expect(within(row("Session a")).getByText(/Apply edit to redirect\.ts\?/)).toBeInTheDocument();
    expect(within(row("Session a")).getByText("Needs you")).toBeInTheDocument();
    expect(row("Session b")).not.toHaveAttribute("data-needs-you");
  });

  // The switch asks inside the row that was pressed; Stay is the default answer.
  it("asks inside the pressed row, and Enter or Esc answers Stay", () => {
    const onAnswer = vi.fn();
    const onClose = vi.fn();
    renderList({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeSessionId: "a",
      onSelect: vi.fn(),
      onClose,
      confirm: { sessionId: "b", text: "Rei is waiting for your answer.", onAnswer },
    });
    const ask = screen.getByRole("alertdialog", { name: "Switch conversation?" });
    expect(within(ask).getByRole("option", { name: "Session b" })).toBeInTheDocument();
    expect(within(ask).getByRole("button", { name: /Stay/ })).toHaveFocus();
    fireEvent.keyDown(ask, { key: "Escape" });
    fireEvent.keyDown(ask, { key: "Enter" });
    expect(onAnswer.mock.calls).toEqual([[false], [false]]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Switch anyway" }));
    expect(onAnswer).toHaveBeenLastCalledWith(true);
  });

  it("asks above the list when the question has no row (a new conversation)", () => {
    renderList({
      sessions: [session({ id: "a" })],
      onNewSession: vi.fn(),
      onSelect: vi.fn(),
      confirm: { sessionId: null, text: "Rei is waiting for your answer.", onAnswer: vi.fn() },
    });
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Rei is waiting for your answer.");
  });
});
