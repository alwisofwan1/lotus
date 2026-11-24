import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ClosedWorkspaceTaskClient } from "@/modules/tasks/services/closed-workspace-tasks";
import { VAULT_CAPABILITIES, VAULT_PROJECT_ID } from "@/modules/tasks/services/vault-mapping";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * Tasks from closed workspaces are recovered from the tracker's own navigation, into a workspace
 * that holds tasks — never into the vault, which is not a place Lotus writes tasks.
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

function renderSurface(board: TrackerBoard, client: ClosedWorkspaceTaskClient) {
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
      closedWorkspaceClient={client}
    />,
  );
  return { onClose };
}

describe("tasks from closed workspaces", () => {
  it("sit in the tasks navigation, and moving them re-reads the board", async () => {
    const vault: TrackerProject = { id: VAULT_PROJECT_ID, name: "Vault", prefix: "", vocabulary: LOTUS_VOCABULARY, capabilities: VAULT_CAPABILITIES, source: { kind: "obsidian", syncLine: "Obsidian · watching folder" } };
    const client: ClosedWorkspaceTaskClient = {
      list: vi.fn(async () => [
        { workspaceId: "12589d98-aaaa", taskCount: 3, openCount: 2, lastUpdatedAt: 1, sampleTitles: ["Old task"], ignored: false },
      ]),
      move: vi.fn(async () => ({ moved: 3, skippedDuplicates: 0 })),
      setIgnored: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const board = boardWith({
      projects: [project, vault],
      projectsById: new Map([[project.id, project], [vault.id, vault]]),
    });
    renderSurface(board, client);

    const nav = within(screen.getByRole("navigation", { name: "Tasks navigation" }));
    const section = within(await nav.findByRole("region", { name: "From closed workspaces" }));
    // The vault is not a workspace: it neither counts as open nor is offered as a target.
    expect(client.list).toHaveBeenCalledWith(["ws-1"]);
    const target = section.getByRole("combobox", { name: /Move tasks from 12589d98 into/ });
    expect(within(target).queryByRole("option", { name: "Vault" })).toBeNull();

    fireEvent.click(section.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(client.move).toHaveBeenCalledWith("12589d98-aaaa", "ws-1"));
    await waitFor(() => expect(board.refresh).toHaveBeenCalledTimes(1));
  });
});
