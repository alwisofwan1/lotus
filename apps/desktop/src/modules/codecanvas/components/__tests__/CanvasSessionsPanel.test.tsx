import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasSessionsPanel } from "../sessions/CanvasSessionsPanel";
import type { CanvasSessionRecord, CanvasSessionStatus } from "../../services/session-record";

const NOW = new Date(2026, 10, 13, 15, 0).getTime();
const HOUR = 3_600_000;

function session(
  overrides: Partial<CanvasSessionRecord> & { id: string; status?: CanvasSessionStatus },
): CanvasSessionRecord {
  return {
    projectId: "cp_1",
    nodeId: `node-${overrides.id}`,
    runner: "claude",
    cwd: "/repos/demo",
    title: `Session ${overrides.id}`,
    status: "resumable",
    origin: "manual",
    turnCount: 2,
    lastActivityAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

/** A board where every row's node is mounted, awake, and in some other conversation. */
const onBoard = {
  projectId: "cp_1",
  isRegistered: () => true,
  isDormant: () => false,
  activeSessionId: () => null,
};

function renderPanel(props: Partial<React.ComponentProps<typeof CanvasSessionsPanel>> = {}) {
  return render(
    <CanvasSessionsPanel
      sessions={[]}
      loading={false}
      error={null}
      now={NOW}
      board={onBoard}
      onDispatchSession={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

const row = (name: RegExp | string) => screen.getByRole("option", { name });

describe("CanvasSessionsPanel", () => {
  it("says the project is empty rather than showing a blank panel", () => {
    renderPanel();
    expect(screen.getByText("No sessions in this project yet.")).toBeInTheDocument();
  });

  it("distinguishes loading from genuinely empty", () => {
    renderPanel({ loading: true });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("bands running sessions apart from the rest, which are grouped by day", () => {
    renderPanel({
      sessions: [
        session({ id: "a", status: "live" }),
        session({ id: "b", lastActivityAt: NOW - HOUR }),
        session({ id: "c", lastActivityAt: NOW - 24 * HOUR }),
        session({ id: "d", lastActivityAt: NOW - 5 * 24 * HOUR }),
      ],
    });
    const bands = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(bands).toEqual(["Running", "Today", "Yesterday", "Earlier"]);
  });

  it("titles a row by the conversation and puts the agent in the meta line", () => {
    renderPanel({
      sessions: [session({ id: "a", title: "Transcript route", runner: "codex", lastActivityAt: NOW - 2 * HOUR })],
      agentNames: { "node-a": "Rowan" },
    });
    expect(within(row("Transcript route")).getByText("Rowan · codex · 2h")).toBeInTheDocument();
  });

  it("names a placeholder-titled row by what it was asked", () => {
    renderPanel({ sessions: [session({ id: "a", title: "Rowan · sesi baru", lastPrompt: "fix the redirect" })] });
    expect(row("fix the redirect")).toBeInTheDocument();
  });

  it("hides machine-started conversations", () => {
    renderPanel({ sessions: [session({ id: "a" }), session({ id: "b", origin: "graph-run" })] });
    expect(screen.queryByRole("option", { name: "Session b" })).not.toBeInTheDocument();
  });

  it("hands every press to the one dispatcher", () => {
    const onDispatchSession = vi.fn();
    const saved = session({ id: "a" });
    renderPanel({ sessions: [saved], onDispatchSession });

    fireEvent.click(row("Session a"));
    expect(onDispatchSession).toHaveBeenCalledWith(saved);
  });

  it("opens the highlighted row with Enter and moves with the arrow keys", () => {
    const onDispatchSession = vi.fn();
    const newer = session({ id: "a" });
    const older = session({ id: "b", lastActivityAt: NOW - HOUR });
    renderPanel({ sessions: [older, newer], onDispatchSession });

    const search = screen.getByRole("combobox");
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(row("Session b")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onDispatchSession).toHaveBeenCalledWith(older);
  });

  it("leaves a lost conversation unpressable and says why", () => {
    const onDispatchSession = vi.fn();
    renderPanel({ sessions: [session({ id: "a", status: "dead" })], onDispatchSession });

    const dead = row("Session a");
    expect(dead).toHaveAttribute("aria-disabled", "true");
    expect(within(dead).getByText(/Can't be resumed/)).toBeInTheDocument();
    fireEvent.click(dead);
    expect(onDispatchSession).not.toHaveBeenCalled();
  });

  // The ghost row: its node is not on this canvas, and it is pressable, because the dispatcher will
  // make the node it needs (`plans/codecanvas-session-refactor/issues/03`).
  it("lets a row whose node is not on this board be opened", () => {
    const onDispatchSession = vi.fn();
    const elsewhere = session({ id: "a" });
    renderPanel({
      sessions: [elsewhere],
      board: { ...onBoard, isRegistered: () => false },
      onDispatchSession,
    });
    fireEvent.click(row("Session a"));
    expect(onDispatchSession).toHaveBeenCalledWith(elsewhere);
  });

  // A refusal for a fixable reason stays pressable, so the dispatcher can say why.
  it("keeps a row pressable when the refusal still has something to say", () => {
    const onDispatchSession = vi.fn();
    const custom = session({ id: "a", runner: "custom" });
    renderPanel({
      sessions: [custom],
      board: { ...onBoard, isRegistered: () => false },
      onDispatchSession,
    });
    fireEvent.click(row("Session a"));
    expect(onDispatchSession).toHaveBeenCalledWith(custom);
  });

  it("says a detached conversation has no node", () => {
    renderPanel({ sessions: [session({ id: "a", nodeId: null })] });
    expect(within(row("Session a")).getByText(/No node/)).toBeInTheDocument();
  });

  it("pins and deletes from the row's own menu, without opening the row", () => {
    const onDeleteSession = vi.fn();
    const onTogglePinned = vi.fn();
    const onDispatchSession = vi.fn();
    const saved = session({ id: "a" });
    renderPanel({ sessions: [saved], onDeleteSession, onTogglePinned, onDispatchSession });

    fireEvent.click(screen.getByRole("button", { name: "Options for Session a" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Pin/ }));
    expect(onTogglePinned).toHaveBeenCalledWith(saved, true);

    fireEvent.click(screen.getByRole("button", { name: "Options for Session a" }));
    expect(screen.getByText(/transcript stays on disk/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(onDeleteSession).toHaveBeenCalledWith(saved);
    expect(onDispatchSession).not.toHaveBeenCalled();
  });

  // A row whose CLI is still running must not vanish from the list while the process lives on.
  it("does not offer delete on a running conversation", () => {
    renderPanel({ sessions: [session({ id: "a", status: "live" })], onDeleteSession: vi.fn() });
    expect(screen.queryByRole("button", { name: "Options for Session a" })).not.toBeInTheDocument();
  });

  it("names what it deleted, says the transcript is kept, and offers to undo it", () => {
    const onUndoDelete = vi.fn();
    renderPanel({ pendingDelete: session({ id: "a" }), onUndoDelete });

    expect(screen.getByText(/Deleted.*Transcript kept/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndoDelete).toHaveBeenCalledOnce();
  });

  it("shows a store error without hiding the sessions it already has", () => {
    renderPanel({ sessions: [session({ id: "a" })], error: "database is locked" });
    expect(screen.getByText("database is locked")).toBeInTheDocument();
    expect(row("Session a")).toBeInTheDocument();
  });

  it("filters by title, by what was said inside, or by agent", () => {
    renderPanel({
      sessions: [
        session({ id: "a", title: "fix resume", lastPrompt: "resume breaks halfway" }),
        session({ id: "b", title: "panel tests", lastPrompt: "add vitest" }),
      ],
      agentNames: { "node-b": "Rowan" },
    });
    const search = screen.getByRole("combobox");
    fireEvent.change(search, { target: { value: "vitest" } });
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["panel tests"]);
    fireEvent.change(search, { target: { value: "rowan" } });
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["panel tests"]);
    fireEvent.change(search, { target: { value: "nothing like it" } });
    expect(screen.getByText("No sessions match “nothing like it”.")).toBeInTheDocument();
  });

  it("clears the search on Escape before closing", () => {
    const onClose = vi.fn();
    renderPanel({ sessions: [session({ id: "a" })], onClose });
    const search = screen.getByRole("combobox");
    fireEvent.change(search, { target: { value: "x" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a click outside, but not on its own opener", () => {
    const onClose = vi.fn();
    render(<button type="button" data-session-list-toggle="">opener</button>);
    renderPanel({ onClose });
    fireEvent.pointerDown(screen.getByText("opener"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("leads Running with the agent that needs you, and says what it is waiting on", () => {
    renderPanel({
      sessions: [
        session({ id: "busy", status: "live", lastActivityAt: NOW }),
        session({ id: "waiting", status: "live", lastActivityAt: NOW - HOUR }),
      ],
      board: { ...onBoard, activeSessionId: (nodeId: string) => nodeId.replace("node-", "") },
      needsYouByNode: new Map([["node-waiting", { headline: "Apply edit to redirect.ts?" }]]),
    });
    const running = screen.getByRole("group", { name: "Running" });
    const rows = within(running).getAllByRole("option");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Session waiting", "Session busy"]);
    expect(rows[0]).toHaveAttribute("data-needs-you");
    expect(within(rows[0]).getByText(/Apply edit to redirect\.ts\?/)).toBeInTheDocument();
  });

  // A stale `live` row that is not the node's conversation is not the one waiting.
  it("marks only the conversation the waiting node is actually in", () => {
    renderPanel({
      sessions: [session({ id: "a", status: "live" })],
      needsYouByNode: new Map([["node-a", {}]]),
    });
    expect(row("Session a")).not.toHaveAttribute("data-needs-you");
  });

  it("does not open another row while a switch is being asked", () => {
    const onDispatchSession = vi.fn();
    renderPanel({
      sessions: [session({ id: "a" }), session({ id: "b", lastActivityAt: NOW - HOUR })],
      onDispatchSession,
      confirm: { sessionId: "a", text: "Rei is waiting for your answer.", onAnswer: vi.fn() },
    });
    fireEvent.click(row("Session b"));
    expect(onDispatchSession).not.toHaveBeenCalled();
  });
});
