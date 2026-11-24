import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * The tracker's write path, from the control someone clicks down to the call the board receives.
 *
 * The board is stubbed on purpose: what is being checked here is that the surface asks for the
 * right thing — `useTrackerBoard` owns the optimistic apply and the rollback, and those are tested
 * as pure functions in `task-draft.test.ts`.
 */

const NO_VAULT = { path: "", connect: () => {}, disconnect: () => {} };

const project: TrackerProject = { id: "ws-1", name: "Lotus", prefix: "LOT", vocabulary: LOTUS_VOCABULARY };
const task: TrackerTask = {
  id: "t1",
  projectId: "ws-1",
  number: 2,
  title: "Fix the flaky login test",
  status: "todo",
  priority: "none",
  createdAt: 1,
  updatedAt: 1,
};

function boardWith(overrides: Partial<TrackerBoard> = {}): TrackerBoard {
  return {
    projects: [project],
    projectsById: new Map([[project.id, project]]),
    tasks: [task],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => null),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    openTask: vi.fn(async () => null),
    ...overrides,
  };
}

function renderSurface(board: TrackerBoard, onClose: () => void = vi.fn()) {
  return render(
    <TasksSurface
      vault={NO_VAULT}
      spawner={null}
      activities={new Map()}
      board={board}
      layout={DEFAULT_LAYOUT}
      onLayoutChange={vi.fn()}
      onClose={onClose}
    />,
  );
}

describe("making a task", () => {
  it("opens New task as a dialog, with the title ready to type into", () => {
    const board = boardWith();
    renderSurface(board);

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    expect(screen.getByRole("dialog", { name: /New task/ })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Task title"));
  });

  it("creates on Enter, with the brief, status and priority chosen", async () => {
    const board = boardWith();
    renderSurface(board);
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));

    const input = screen.getByLabelText("Task title");
    fireEvent.change(input, { target: { value: "Ship the tracker" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Behind a flag." } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "in-progress" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "high" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(board.createTask).toHaveBeenCalledWith({
        title: "Ship the tracker",
        description: "Behind a flag.",
        projectId: "ws-1",
        priority: "high",
        status: "in-progress",
      }),
    );
  });

  it("with Create more on, stays open and empties, because tasks arrive in handfuls", async () => {
    const board = boardWith();
    renderSurface(board);
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));

    const input = screen.getByLabelText("Task title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "One" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("with Create more off, closes once the task is made", async () => {
    const board = boardWith();
    renderSurface(board);
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));

    fireEvent.click(screen.getByLabelText("Create more"));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "One" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes on Escape without closing Tasks behind it", () => {
    const onClose = vi.fn();
    renderSurface(boardWith(), onClose);
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    fireEvent.keyDown(screen.getByLabelText("Task title"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("changing a task from its row", () => {
  it("changes status from the mark that shows it", () => {
    const board = boardWith();
    renderSurface(board);

    fireEvent.click(screen.getByLabelText("Status: Todo"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "In Progress" }));

    expect(board.editTask).toHaveBeenCalledWith("t1", { status: "in-progress" });
  });

  it("changes priority from the mark that shows it", () => {
    const board = boardWith();
    renderSurface(board);

    fireEvent.click(screen.getByLabelText("Priority: No priority"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));

    expect(board.editTask).toHaveBeenCalledWith("t1", { priority: "high" });
  });

  it("says nothing to the store when the value picked is the one already set", () => {
    const board = boardWith();
    renderSurface(board);

    fireEvent.click(screen.getByLabelText("Status: Todo"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Todo" }));

    expect(board.editTask).not.toHaveBeenCalled();
  });

  it("renames in place on double click, and saves on Enter", () => {
    const board = boardWith();
    renderSurface(board);

    fireEvent.doubleClick(screen.getByRole("button", { name: task.title }));
    const input = screen.getByLabelText("Task title");
    fireEvent.change(input, { target: { value: "Fix login flakiness" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(board.editTask).toHaveBeenCalledWith("t1", { title: "Fix login flakiness" });
  });

  it("keeps the old name when the edit is abandoned", () => {
    const board = boardWith();
    renderSurface(board);

    fireEvent.doubleClick(screen.getByRole("button", { name: task.title }));
    const input = screen.getByLabelText("Task title");
    fireEvent.change(input, { target: { value: "something else" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(board.editTask).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: task.title })).toBeTruthy();
  });

  it("refuses to erase a title: an empty box is a slip, not an instruction", () => {
    const board = boardWith();
    renderSurface(board);

    fireEvent.doubleClick(screen.getByRole("button", { name: task.title }));
    const input = screen.getByLabelText("Task title");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(board.editTask).not.toHaveBeenCalled();
  });
});

describe("agent presets, from the sidebar", () => {
  it("offers New preset in the sidebar and opens the editor as a dialog", () => {
    renderSurface(boardWith());
    fireEvent.click(screen.getByRole("button", { name: "New preset" }));
    const dialog = screen.getByRole("dialog", { name: "New preset" });
    expect(dialog).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Agent and model")).toBeTruthy();
    expect(screen.getByLabelText("Permissions")).toBeTruthy();
  });

  it("says why a preset was not saved instead of closing on a refusal", async () => {
    renderSurface(boardWith());
    fireEvent.click(screen.getByRole("button", { name: "New preset" }));
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
    expect(await screen.findByText("A preset needs a name.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("lists a saved preset in the sidebar, and opens it again as Edit preset", async () => {
    renderSurface(boardWith());
    fireEvent.click(screen.getByRole("button", { name: "New preset" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Claude careful" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));

    const row = await screen.findByRole("button", { name: "Claude careful" });
    fireEvent.click(row);
    expect(screen.getByRole("dialog", { name: "Edit preset" })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Claude careful");
  });
});

describe("bulk actions and the list keyboard (Tasks revamp D6, D8)", () => {
  const second: TrackerTask = { ...task, id: "t2", number: 3, title: "Write the release notes" };
  const third: TrackerTask = { ...task, id: "t3", number: 4, title: "Tidy the sidebar" };

  it("ticks a range with Shift, sets status on every ticked row, and Undo puts them back", async () => {
    const board = boardWith({ tasks: [task, second, third] });
    renderSurface(board);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select LOT-2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select LOT-4" }), { shiftKey: true });
    expect(screen.getByText("3 selected")).toBeTruthy();

    fireEvent.click(screen.getByText("Status", { selector: "summary" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "In Review" }));
    expect(board.editTask).toHaveBeenCalledTimes(3);
    for (const id of ["t1", "t2", "t3"]) expect(board.editTask).toHaveBeenCalledWith(id, { status: "in-review" });
    expect(screen.queryByRole("toolbar", { name: "Bulk actions" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: /Undo/ }));
    expect(board.editTask).toHaveBeenCalledWith("t2", { status: "todo", priority: "none" });
  });

  it("says which rows failed, and Undo puts back only the rows that were saved", async () => {
    const editTask = vi.fn(async (id: string) => (id === "t2" ? "That change was not saved: offline" : null));
    const board = boardWith({ tasks: [task, second], editTask });
    renderSurface(board);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select LOT-2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select LOT-3" }));
    fireEvent.click(screen.getByText("Status", { selector: "summary" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));

    expect(await screen.findByText(/1 of 2 tasks → Done · 1 failed: That change was not saved: offline/)).toBeTruthy();
    editTask.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(editTask).toHaveBeenCalledTimes(1);
    expect(editTask).toHaveBeenCalledWith("t1", { status: "todo", priority: "none" });
  });

  it("offers Status across two Lotus workspaces, since they share one set of statuses", () => {
    const other: TrackerProject = { id: "ws-2", name: "Teamku", prefix: "TEA", vocabulary: LOTUS_VOCABULARY };
    const elsewhere: TrackerTask = { ...second, projectId: "ws-2" };
    renderSurface(
      boardWith({ projects: [project, other], projectsById: new Map([[project.id, project], [other.id, other]]), tasks: [task, elsewhere] }),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select LOT-2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select TEA-3" }));
    expect(screen.getByText("Status", { selector: "summary" })).toBeTruthy();
  });

  it("J moves the cursor, X ticks it, Escape clears ticks before it closes Tasks", () => {
    const onClose = vi.fn();
    renderSurface(boardWith({ tasks: [task, second] }), onClose);

    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "x" });
    expect(screen.getByRole("checkbox", { name: "Select LOT-3" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("1 selected")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
