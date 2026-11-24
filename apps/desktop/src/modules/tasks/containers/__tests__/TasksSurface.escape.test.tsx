import { useState } from "react";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { VAULT_CAPABILITIES, VAULT_PROJECT_ID } from "@/modules/tasks/services/vault-mapping";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * Escape belongs to the innermost thing that answers it.
 *
 * The tracker listens for Escape on the window to step back one level. A control inside it that
 * already used the key — a rename it cancelled, a menu it closed — must not ALSO step the tracker
 * back: one key, one step.
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

function renderSurface(board: TrackerBoard) {
  const onClose = vi.fn();
  render(
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
  return { onClose };
}

describe("Escape inside the tracker", () => {
  it("cancelling a rename keeps the tracker open", () => {
    const board = boardWith();
    const { onClose } = renderSurface(board);

    fireEvent.doubleClick(screen.getByRole("button", { name: row.title }));
    fireEvent.keyDown(screen.getByLabelText("Task title"), { key: "Escape" });

    expect(screen.queryByLabelText("Task title")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(board.editTask).not.toHaveBeenCalled();
  });

  it("an open filter menu closes first, and the tracker stays", () => {
    const { onClose } = renderSurface(boardWith());

    const chip = screen.getByLabelText("Filter").closest("details")!;
    chip.open = true;
    fireEvent.keyDown(screen.getByLabelText("Filter by…"), { key: "Escape" });

    expect(chip.open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an open status menu on a row closes first, and the tracker stays", () => {
    const { onClose } = renderSurface(boardWith());

    const chip = screen.getByLabelText("Status: Todo").closest("details")!;
    chip.open = true;
    fireEvent.keyDown(chip.querySelector("summary")!, { key: "Escape" });

    expect(chip.open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("with nothing inside claiming it, still closes the tracker", () => {
    const { onClose } = renderSurface(boardWith());

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the status filter across views", () => {
  const vault: TrackerProject = {
    id: VAULT_PROJECT_ID, name: "orbit-vault", prefix: "", vocabulary: VAULT_VOCABULARY, capabilities: VAULT_CAPABILITIES,
    source: { kind: "obsidian", syncLine: "Obsidian · watching folder" },
  };
  const ticket: TrackerTask = {
    id: "TKT-1.md", projectId: VAULT_PROJECT_ID, key: "TKT-1", title: "Bounced by QA",
    status: "qa-revision" as TrackerTask["status"], priority: "none", createdAt: 1, updatedAt: 1,
  };
  const twoSources = () =>
    boardWith({
      projects: [project, vault],
      projectsById: new Map([[project.id, project], [vault.id, vault]]),
      tasks: [row, ticket],
    });
  const nav = () => within(screen.getByRole("navigation", { name: "Tasks navigation" }));
  const statusChip = () => within(screen.getByRole("group", { name: "Filter by status" }));

  /** The layout the surface writes, fed back in — filters live there now, per view. */
  function renderLive(board: TrackerBoard) {
    function Live() {
      const [layout, setLayout] = useState(DEFAULT_LAYOUT);
      return (
        <TasksSurface
          vault={NO_VAULT}
          spawner={null}
          activities={new Map()}
          board={board}
          layout={layout}
          onLayoutChange={(patch) => setLayout((current) => ({ ...current, ...patch }))}
          onClose={vi.fn()}
        />
      );
    }
    render(<Live />);
  }
  const addStatusFilter = () => {
    fireEvent.click(screen.getByLabelText("Filter"));
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by property" })).getByRole("button", { name: /Status/ }));
    return within(screen.getByRole("group", { name: "Filter by status" }));
  };

  it("each view keeps its own filters, so one chosen in a board never empties another", () => {
    renderLive(twoSources());

    fireEvent.click(nav().getByRole("button", { name: /orbit-vault/ }));
    fireEvent.click(addStatusFilter().getByRole("button", { name: /Todo/ }));
    expect(screen.queryByRole("button", { name: ticket.title })).toBeNull();
    expect(screen.getByText("Nothing matches these filters.")).toBeTruthy();

    fireEvent.click(nav().getByRole("button", { name: /All tasks/ }));
    expect(screen.getByRole("button", { name: row.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: ticket.title })).toBeTruthy();

    // Back on the board, its rule is where it was left.
    fireEvent.click(nav().getByRole("button", { name: /orbit-vault/ }));
    expect(screen.getByLabelText("Status: Todo")).toBeTruthy();
  });

  it("All tasks offers every project's statuses, under whose words they are", () => {
    renderLive(twoSources());

    const menu = addStatusFilter();
    expect(menu.getByText("orbit-vault")).toBeTruthy();
    fireEvent.click(menu.getByRole("button", { name: /QA Revision/ }));

    expect(screen.getByRole("button", { name: ticket.title })).toBeTruthy();
    expect(screen.queryByRole("button", { name: row.title })).toBeNull();
  });

  it("Clear filters in the empty list gives the rows back", () => {
    renderLive(twoSources());

    fireEvent.click(nav().getByRole("button", { name: /orbit-vault/ }));
    fireEvent.click(addStatusFilter().getByRole("button", { name: /Todo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.getByRole("button", { name: ticket.title })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
  });
});
