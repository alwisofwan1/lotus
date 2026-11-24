import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { VAULT_CAPABILITIES, VAULT_PROJECT_ID } from "@/modules/tasks/services/vault-mapping";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";

/**
 * A Delegate that fails says why on the open panel (LOT2-108). It used to be written only above
 * the list — which the open panel covers — so a failed Delegate looked like a button that did nothing.
 */

const FAILED = "The agent could not be started: no shell.";
const delegate = vi.fn(async (): Promise<string | null> => FAILED);
const claude = { id: "c", name: "Alwi", agent: "claude", args: "", instructions: "" };
vi.mock("@/modules/tasks/hooks/useDelegation", () => ({
  DENY_NEEDS_CLAUDE: "",
  useDelegation: () => ({
    presets: [claude],
    ready: true,
    delegate,
    savePreset: vi.fn(),
    updatePreset: vi.fn(),
    removePreset: vi.fn(),
    resume: vi.fn(),
    inFlight: new Set(),
  }),
}));

const lotus: TrackerProject = { id: "ws-1", name: "Workspace 3", prefix: "W3", vocabulary: LOTUS_VOCABULARY };
const vault: TrackerProject = {
  id: VAULT_PROJECT_ID,
  name: "orbit-vault",
  prefix: "",
  vocabulary: VAULT_VOCABULARY,
  capabilities: VAULT_CAPABILITIES,
  source: { kind: "obsidian", syncLine: "Obsidian · watching folder" },
};
const ticketRow: TrackerTask = {
  id: "TKT-874.md", projectId: VAULT_PROJECT_ID, key: "TKT-874", title: "Remove legacy module",
  status: "in-progress", priority: "none", createdAt: 1, updatedAt: 1,
};
const taskRow: TrackerTask = {
  id: "task_9", projectId: lotus.id, number: 5, title: "Fix the gate", status: "todo",
  priority: "none", createdAt: 1, updatedAt: 1,
};
const otherRow: TrackerTask = { ...taskRow, id: "task_10", number: 6, title: "Another task" };
const bridgeTask = (row: TrackerTask) =>
  ({ id: row.id, workspaceId: lotus.id, number: row.number, title: row.title, goal: "", status: "todo", priority: "none", createdAt: 1, updatedAt: 1 }) as unknown as BridgeTask;
const made = { id: "task_new", workspaceId: lotus.id } as unknown as BridgeTask;

function board(): TrackerBoard {
  return {
    projects: [lotus, vault],
    projectsById: new Map([[lotus.id, lotus], [vault.id, vault]]),
    tasks: [ticketRow, taskRow, otherRow],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => made),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    openTask: vi.fn(async (projectId: string, id: string) =>
      projectId === VAULT_PROJECT_ID
        ? {
            kind: "ticket" as const,
            detail: {
              ticket: { file: "TKT-874.md", ticket: "TKT-874", title: ticketRow.title, status: "in-progress", tags: [], modifiedAt: 1 },
              sections: [{ body: "Orphaned flow." }],
              revision: "r1",
            },
          }
        : { kind: "task" as const, task: bridgeTask(id === otherRow.id ? otherRow : taskRow) },
    ),
  } as unknown as TrackerBoard;
}

function renderSurface() {
  render(
    <TasksSurface
      vault={{ path: "/vault", connect: vi.fn(), disconnect: vi.fn() }}
      spawner={{ addPane: () => "pane_1" }}
      activities={new Map()}
      board={board()}
      layout={DEFAULT_LAYOUT}
      onLayoutChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

async function delegateFrom(title: string) {
  fireEvent.click(screen.getByRole("button", { name: title }));
  const props = await screen.findByRole("complementary", { name: "Properties" });
  fireEvent.click(within(props).getByRole("button", { name: /^Alwi/, hidden: true }));
  await waitFor(() => expect(delegate).toHaveBeenCalled());
}

const shownOnPanel = () =>
  screen.queryAllByRole("alert").some((alert) => alert.closest(".tk-detail-main") && alert.textContent === FAILED);

describe("a failed Delegate, seen from the open panel (LOT2-108)", () => {
  beforeEach(() => delegate.mockClear());

  it("shows on a vault ticket's panel", async () => {
    renderSurface();
    await delegateFrom(ticketRow.title);
    await waitFor(() => expect(shownOnPanel()).toBe(true));
  });

  it("shows on a task's panel", async () => {
    renderSurface();
    await delegateFrom(taskRow.title);
    await waitFor(() => expect(shownOnPanel()).toBe(true));
  });

  it("does not follow to the next panel opened", async () => {
    renderSurface();
    await delegateFrom(taskRow.title);
    await waitFor(() => expect(shownOnPanel()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    fireEvent.click(await screen.findByRole("button", { name: otherRow.title }));
    await screen.findByRole("heading", { name: otherRow.title });
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});
