import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * Opening a task shows the record the agents have been writing all along.
 *
 * The board is stubbed, so what is checked here is the surface: that opening a row reads the WHOLE
 * task rather than drawing the narrow list row, that the record is on screen, and that Escape
 * steps out of the task before it steps out of the tracker.
 */

const NO_VAULT = { path: "", connect: () => {}, disconnect: () => {} };

const project: TrackerProject = { id: "ws-1", name: "Lotus", prefix: "LOT", vocabulary: LOTUS_VOCABULARY };

const row: TrackerTask = {
  id: "t1",
  projectId: "ws-1",
  number: 2,
  title: "Fix the flaky login test",
  status: "todo",
  priority: "none",
  createdAt: 1,
  updatedAt: 1,
};

const stored: BridgeTask = {
  id: "t1",
  workspaceId: "ws-1",
  number: 2,
  title: "Fix the flaky login test",
  goal: "Make the login spec pass ten times in a row",
  knowledge: "It fails on CI only",
  status: "todo",
  priority: "none",
  assignees: [],
  createdAt: 1,
  updatedAt: Date.now(),
  intake: { briefXml: "<brief/>", confidence: 0.82, decision: "assign", updatedAt: 1 },
  blocker: { phase: "execution", type: "auth", reason: "claude is not signed in" },
  feedbackEvents: [
    { id: "e2", at: Date.now(), actor: "agent", kind: "agent-result", summary: "Reran the spec" },
    { id: "e1", at: Date.now() - 3_600_000, actor: "director", kind: "intake-created", summary: "" },
  ],
};

function boardWith(overrides: Partial<TrackerBoard> = {}): TrackerBoard {
  return {
    projects: [project],
    projectsById: new Map([[project.id, project]]),
    tasks: [row],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => null),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    openTask: vi.fn(async () => ({ kind: "task" as const, task: stored })),
    ...overrides,
  };
}

function renderSurface(board: TrackerBoard, onClose = vi.fn()) {
  render(
    <TasksSurface vault={NO_VAULT}
      spawner={null}
      activities={new Map()} board={board} layout={DEFAULT_LAYOUT} onLayoutChange={vi.fn()} onClose={onClose} />,
  );
  return { onClose };
}

async function openTheTask(board: TrackerBoard) {
  fireEvent.click(screen.getByRole("button", { name: row.title }));
  await waitFor(() => expect(board.openTask).toHaveBeenCalledWith("ws-1", "t1"));
}

describe("opening a task", () => {
  it("reads the whole stored task, not the list row", async () => {
    const board = boardWith();
    renderSurface(board);
    await openTheTask(board);

    // The goal lives only on the stored task; a list row has never carried it.
    expect(await screen.findByText("Make the login spec pass ten times in a row")).toBeTruthy();
  });

  it("shows the record the MCP tools wrote — which nothing could read before", async () => {
    const board = boardWith();
    renderSurface(board);
    await openTheTask(board);

    expect(await screen.findByText(/Assign to an agent · 82% confident/)).toBeTruthy();
    expect(screen.getByText(/not signed in while doing the work/)).toBeTruthy();
    expect(screen.getByText("Reran the spec")).toBeTruthy();
  });

  it("tells the story oldest first", async () => {
    const board = boardWith();
    renderSurface(board);
    await openTheTask(board);

    const entries = (await screen.findAllByRole("listitem")).map((item) => item.textContent ?? "");
    const director = entries.findIndex((text) => text.includes("Director"));
    const agent = entries.findIndex((text) => text.includes("Agent"));
    expect(director).toBeLessThan(agent);
  });

  it("says so when the store could not produce the task", async () => {
    const board = boardWith({ openTask: vi.fn(async () => null) });
    renderSurface(board);
    await openTheTask(board);

    expect(await screen.findByText("That task could not be read.")).toBeTruthy();
  });
});

describe("getting back out", () => {
  it("returns to the list from the detail", async () => {
    const board = boardWith();
    renderSurface(board);
    await openTheTask(board);

    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    expect(screen.getByRole("button", { name: /New task/ })).toBeTruthy();
  });

  it("steps out of the task first, and out of the tracker second", async () => {
    const board = boardWith();
    const { onClose } = renderSurface(board);
    await openTheTask(board);

    fireEvent.keyDown(window, { key: "Escape" });
    // Still in the tracker: one key, one step.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /New task/ })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("changing a task from its detail", () => {
  it("sends the change and shows it without waiting for a re-read", async () => {
    const board = boardWith();
    renderSurface(board);
    await openTheTask(board);

    fireEvent.click(screen.getByLabelText("Status: Todo"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "In Progress" }));

    expect(board.editTask).toHaveBeenCalledWith("t1", { status: "in-progress" });
    await waitFor(() => expect(screen.getByLabelText("Status: In Progress")).toBeTruthy());
  });
});

describe("presets from the Delegate menu", () => {
  it("opens the same preset editor the sidebar opens, not a second smaller form", async () => {
    const board = boardWith();
    renderSurface(board);
    await openTheTask(board);

    const summary = screen.getByText("Delegate");
    fireEvent.click(summary);
    // The sidebar has its own "New preset" row; the menu's is the one inside the Delegate menu.
    const menu = summary.closest("details") as HTMLElement;
    fireEvent.click(within(menu).getByRole("button", { name: "New preset" }));

    expect(screen.getByRole("dialog", { name: "New preset" })).toBeTruthy();
    expect(screen.getByLabelText("Agent and model")).toBeTruthy();
  });
});

describe("the brief, rendered", () => {
  it("renders markdown and drops a first heading that only repeats the title", async () => {
    const board = boardWith({
      openTask: vi.fn(async () => ({
        kind: "task" as const,
        task: { ...stored, goal: "# Fix the flaky login test\n\nIt fails **only on CI**.\n\n| a | b |\n|---|---|\n| 1 | 2 |" },
      })),
    });
    renderSurface(board);
    await openTheTask(board);

    expect((await screen.findByText("only on CI")).tagName).toBe("STRONG");
    expect(screen.getByRole("table")).toBeTruthy();
    // The title is on the page once — the brief's own copy of it is gone.
    expect(screen.getAllByText("Fix the flaky login test", { selector: "h1,h2,h3" })).toHaveLength(1);
  });
});

describe("stepping between tasks", () => {
  it("walks to the next row the list draws, without going back to the list", async () => {
    const second: TrackerTask = { ...row, id: "t2", number: 3, title: "Second task" };
    const board = boardWith({ tasks: [row, second] });
    renderSurface(board);
    await openTheTask(board);

    expect(await screen.findByText("1 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next task" }));
    await waitFor(() => expect(board.openTask).toHaveBeenCalledWith("ws-1", "t2"));
  });
});

describe("the sidebar while a task is open", () => {
  it("leaves the task and shows the list it was asked for", async () => {
    const board = boardWith();
    renderSurface(board);
    await openTheTask(board);
    expect(await screen.findByText("Make the login spec pass ten times in a row")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Running agents/ }));

    expect(screen.queryByText("Make the login spec pass ten times in a row")).toBeNull();
    expect(screen.getByRole("heading", { name: "Running agents" })).toBeTruthy();
  });
});

describe("hiding the Tasks sidebar", () => {
  it("hides and shows it from the list header, and remembers the choice", () => {
    const onLayoutChange = vi.fn();
    const { rerender } = render(
      <TasksSurface vault={NO_VAULT} spawner={null} activities={new Map()} board={boardWith()}
        layout={DEFAULT_LAYOUT} onLayoutChange={onLayoutChange} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("navigation", { name: "Tasks navigation" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(onLayoutChange).toHaveBeenCalledWith({ taskNavVisible: false });

    rerender(
      <TasksSurface vault={NO_VAULT} spawner={null} activities={new Map()} board={boardWith()}
        layout={{ ...DEFAULT_LAYOUT, taskNavVisible: false }} onLayoutChange={onLayoutChange} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("navigation", { name: "Tasks navigation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeTruthy();
  });
});

describe("a task changed while it is open", () => {
  const surface = (board: TrackerBoard) => (
    <TasksSurface vault={NO_VAULT} spawner={null} activities={new Map()} board={board}
      layout={DEFAULT_LAYOUT} onLayoutChange={vi.fn()} onClose={vi.fn()} />
  );

  it("reads itself again when an agent wrote to it from outside", async () => {
    const reported: BridgeTask = {
      ...stored,
      feedbackEvents: [
        ...stored.feedbackEvents!,
        { id: "e3", at: Date.now(), actor: "agent", kind: "agent-result", summary: "Opened the PR" },
      ],
    };
    const openTask = vi
      .fn()
      .mockResolvedValueOnce({ kind: "task" as const, task: stored })
      .mockResolvedValue({ kind: "task" as const, task: reported });
    const board = boardWith({ openTask, lastChange: null });
    const { rerender } = render(surface(board));
    await openTheTask(board);
    await screen.findByText("Reran the spec");

    rerender(surface({ ...board, lastChange: { workspaceId: "ws-1", taskId: "t1", seq: 1 } }));

    expect(await screen.findByText("Opened the PR")).toBeTruthy();
  });

  it("does not re-read for a change to some other task", async () => {
    const board = boardWith({ lastChange: null });
    const { rerender } = render(surface(board));
    await openTheTask(board);
    await screen.findByText("Reran the spec");

    rerender(surface({ ...board, lastChange: { workspaceId: "ws-1", taskId: "other", seq: 1 } }));

    expect(board.openTask).toHaveBeenCalledTimes(1);
  });
});
