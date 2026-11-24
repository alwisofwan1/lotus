import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * `Active` is a list and a number, and they are one answer: tasks a pane is moving on right now.
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

describe("the Active view", () => {
  it("lists exactly what its count counts — a binding whose pane is gone is not active", () => {
    const live: TrackerTask = { ...row, id: "live", number: 3, title: "Being worked on", status: "in-progress", cellId: "p1" };
    const stale: TrackerTask = { ...row, id: "stale", number: 4, title: "Pane long gone", status: "in-progress", cellId: "gone" };
    renderSurface(
      boardWith({ tasks: [live, stale] }),
      new Map([["p1", { activity: "working" as const, since: 0 }]]),
    );

    const nav = within(screen.getByRole("navigation", { name: "Tasks navigation" }));
    const activeRow = nav.getByRole("button", { name: /Running agents/ });
    expect(activeRow.textContent).toContain("1");
    fireEvent.click(activeRow);

    expect(screen.getByRole("button", { name: "Being worked on" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pane long gone" })).toBeNull();
  });
});
