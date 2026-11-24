import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * Finding a task: by what it is called (title or key), typed into the bar above the list.
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
    openTask: vi.fn(async () => null),
    ...overrides,
  };
}

function renderSurface(board: TrackerBoard, activities = new Map()) {
  const onClose = vi.fn();
  render(
    <TasksSurface
      vault={NO_VAULT}
      spawner={null}
      activities={activities}
      board={board}
      layout={DEFAULT_LAYOUT}
      onLayoutChange={vi.fn()}
      onClose={onClose}
    />,
  );
  return { onClose };
}

const other: TrackerTask = { ...row, id: "t2", number: 7, title: "Write the release notes" };

describe("searching the list", () => {
  it("keeps only the rows whose title matches what is typed", () => {
    renderSurface(boardWith({ tasks: [row, other] }));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "release" } });

    expect(screen.getByRole("button", { name: other.title })).toBeTruthy();
    expect(screen.queryByRole("button", { name: row.title })).toBeNull();
  });

  it("finds a task by the key people say out loud", () => {
    renderSurface(boardWith({ tasks: [row, other] }));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "lot-7" } });

    expect(screen.getByRole("button", { name: other.title })).toBeTruthy();
    expect(screen.queryByRole("button", { name: row.title })).toBeNull();
  });

  it("is reached with / from anywhere in the tracker", () => {
    renderSurface(boardWith());

    fireEvent.keyDown(window, { key: "/" });

    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search tasks" }));
  });

  it("Escape in the box clears it, and the tracker stays open", () => {
    const { onClose } = renderSurface(boardWith({ tasks: [row, other] }));
    const box = screen.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(box, { target: { value: "release" } });

    fireEvent.keyDown(box, { key: "Escape" });

    expect((box as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: row.title })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("hiding finished work", () => {
  const shipped: TrackerTask = { ...row, id: "t3", number: 9, title: "Shipped last week", status: "complete" };

  function renderWith(taskHideDone: boolean) {
    const onLayoutChange = vi.fn();
    render(
      <TasksSurface vault={NO_VAULT} spawner={null} activities={new Map()}
        board={boardWith({ tasks: [row, shipped] })}
        layout={{ ...DEFAULT_LAYOUT, taskHideDone }} onLayoutChange={onLayoutChange} onClose={vi.fn()} />,
    );
    return { onLayoutChange };
  }

  it("is on to start with — a tracker is opened to see what is still to do", () => {
    expect(DEFAULT_LAYOUT.taskHideDone).toBe(true);
    renderWith(DEFAULT_LAYOUT.taskHideDone);

    expect(screen.getByRole("button", { name: row.title })).toBeTruthy();
    expect(screen.queryByRole("button", { name: shipped.title })).toBeNull();
  });

  it("shows everything when turned off, and remembers the choice in the layout", () => {
    const { onLayoutChange } = renderWith(false);

    expect(screen.getByRole("button", { name: shipped.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Hide finished/ }));

    expect(onLayoutChange).toHaveBeenCalledWith({ taskHideDone: true });
  });
});
