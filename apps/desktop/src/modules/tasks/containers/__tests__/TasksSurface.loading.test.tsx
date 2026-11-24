import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/** While the board is read, the list shows rows in its own shape, not a "Reading…" line (S6). */

const NO_VAULT = { path: "", connect: () => {}, disconnect: () => {} };
const project: TrackerProject = { id: "ws-1", name: "Lotus", prefix: "LOT", vocabulary: LOTUS_VOCABULARY };
const row: TrackerTask = { id: "t1", projectId: "ws-1", number: 2, title: "Fix the flaky login test", status: "todo", priority: "none", createdAt: 1, updatedAt: 1 };

function board(overrides: Partial<TrackerBoard>): TrackerBoard {
  return {
    projects: [project],
    projectsById: new Map([[project.id, project]]),
    tasks: [],
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

function renderSurface(b: TrackerBoard) {
  return render(
    <TasksSurface vault={NO_VAULT} spawner={null} activities={new Map()} board={b} layout={DEFAULT_LAYOUT} onLayoutChange={vi.fn()} onClose={vi.fn()} />,
  );
}

describe("Tasks loading", () => {
  it("shows skeleton rows while the board is read", () => {
    renderSurface(board({ loading: true }));
    const skeleton = screen.getByRole("list", { name: "Reading tasks" });
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.querySelectorAll(".tk-row--skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByText("Reading tasks…")).toBeNull();
  });

  it("keeps the rows it already has during a refresh", () => {
    renderSurface(board({ loading: true, tasks: [row] }));
    expect(screen.getByRole("button", { name: row.title })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Reading tasks" })).toBeNull();
  });

  it("says the board is empty once it is read, and offers New task", () => {
    renderSurface(board({ loading: false }));
    expect(screen.queryByRole("list", { name: "Reading tasks" })).toBeNull();
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
    const actions = screen.getAllByRole("button", { name: "New task" });
    fireEvent.click(actions[actions.length - 1]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
