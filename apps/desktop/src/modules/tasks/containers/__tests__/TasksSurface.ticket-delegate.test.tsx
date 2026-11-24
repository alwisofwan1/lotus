import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { VAULT_CAPABILITIES, VAULT_PROJECT_ID } from "@/modules/tasks/services/vault-mapping";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * Delegating a ticket, which is the path no test had ever walked.
 *
 * It shipped reporting "open a workspace first" with a workspace plainly selected beside it: the
 * delegation hook was handed a workspace id read only from an open TASK, and a ticket has none —
 * it belongs to no workspace, which is why the panel offers a target at all. Nothing typechecked
 * wrong and every other test passed, because none of them ever opened a ticket.
 */

const NO_VAULT = { path: "/vault", connect: () => {}, disconnect: () => {} };

const lotus: TrackerProject = {
  id: "ws-1",
  name: "Workspace 3",
  prefix: "W3",
  vocabulary: LOTUS_VOCABULARY,
};

const vault: TrackerProject = {
  id: VAULT_PROJECT_ID,
  name: "orbit-vault",
  prefix: "",
  vocabulary: VAULT_VOCABULARY,
  capabilities: VAULT_CAPABILITIES,
  source: { kind: "obsidian", syncLine: "Obsidian · watching folder" },
};

const ticketRow: TrackerTask = {
  id: "TKT-874.md",
  projectId: VAULT_PROJECT_ID,
  key: "TKT-874",
  title: "Remove legacy /billing module",
  status: "in-progress",
  priority: "none",
  createdAt: 1,
  updatedAt: 1,
};

function board(): TrackerBoard {
  return {
    projects: [lotus, vault],
    projectsById: new Map([
      [lotus.id, lotus],
      [vault.id, vault],
    ]),
    tasks: [ticketRow],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => null),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    openTask: vi.fn(async () => ({
      kind: "ticket" as const,
      detail: {
        ticket: {
          file: "TKT-874.md",
          ticket: "TKT-874",
          title: ticketRow.title,
          status: "in-progress",
          tags: [],
          modifiedAt: 1,
        },
        sections: [{ body: "The old license-purchase flow is orphaned." }],
        revision: "r1",
      },
    })),
  };
}

describe("delegating a vault ticket", () => {
  it("does not claim there is nowhere to put the agent when a workspace is chosen", async () => {
    const b = board();
    render(
      <TasksSurface
        vault={NO_VAULT}
        // A spawner is present: the only thing that could be missing is the workspace, and the
        // panel is offering one.
        spawner={{ addPane: () => "pane_1" }}
        activities={new Map()}
        board={b}
        layout={DEFAULT_LAYOUT}
        onLayoutChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: ticketRow.title }));
    await waitFor(() => expect(b.openTask).toHaveBeenCalledWith(VAULT_PROJECT_ID, "TKT-874.md"));

    fireEvent.click(await screen.findByText("Delegate"));

    expect(screen.queryByText(/Open a workspace first/)).toBeNull();
  });

  it("offers the writable projects as targets, never the vault itself", async () => {
    // The vault is where the ticket lives and the one place the work cannot be born.
    const b = board();
    render(
      <TasksSurface
        vault={NO_VAULT}
        spawner={{ addPane: () => "pane_1" }}
        activities={new Map()}
        board={b}
        layout={DEFAULT_LAYOUT}
        onLayoutChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: ticketRow.title }));
    await waitFor(() => expect(b.openTask).toHaveBeenCalled());

    expect(await screen.findByText(/in Workspace 3/)).toBeTruthy();
  });
});

describe("the tasks a ticket has become", () => {
  it("are listed on the ticket, and open from there", async () => {
    const derived: TrackerTask = {
      id: "task_9",
      projectId: lotus.id,
      number: 5,
      title: "TKT-874 — Remove legacy /billing module",
      status: "in-progress",
      priority: "none",
      createdAt: 1,
      updatedAt: 1,
      sourceRef: "TKT-874.md",
    };
    const b = { ...board(), tasks: [ticketRow, derived] };
    render(
      <TasksSurface vault={NO_VAULT} spawner={null} activities={new Map()} board={b}
        layout={DEFAULT_LAYOUT} onLayoutChange={vi.fn()} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: ticketRow.title }));
    const link = await screen.findByRole("button", { name: /W3-5/ });
    fireEvent.click(link);

    await waitFor(() => expect(b.openTask).toHaveBeenCalledWith(lotus.id, "task_9"));
  });
});
