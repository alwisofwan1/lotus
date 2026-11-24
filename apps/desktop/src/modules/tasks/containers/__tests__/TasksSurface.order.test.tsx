import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { VAULT_CAPABILITIES, VAULT_PROJECT_ID } from "@/modules/tasks/services/vault-mapping";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT, type ShellLayoutPreferences } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * Ordering by hand: Manual is one of the sorts, it is remembered, and in it a row can be moved —
 * by dragging, or with Alt+↑ / Alt+↓ from the keyboard, which is what these tests press.
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

const first: TrackerTask = { ...row, id: "a", number: 1, title: "First made" };
const second: TrackerTask = { ...row, id: "b", number: 2, title: "Second made" };
const third: TrackerTask = { ...row, id: "c", number: 3, title: "Third made" };

function renderOrdered(taskSort: ShellLayoutPreferences["taskSort"], board = boardWith({ tasks: [first, second, third] })) {
  const onLayoutChange = vi.fn();
  render(
    <TasksSurface vault={NO_VAULT} spawner={null} activities={new Map()} board={board}
      layout={{ ...DEFAULT_LAYOUT, taskSort }} onLayoutChange={onLayoutChange} onClose={vi.fn()} />,
  );
  return { board, onLayoutChange };
}

const titles = () => [...document.querySelectorAll(".tk-row-title")].map((node) => node.textContent);

describe("ordering by hand", () => {
  it("is a sort of its own, and the choice is remembered", () => {
    const { onLayoutChange } = renderOrdered("number");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Manual" }));

    expect(onLayoutChange).toHaveBeenCalledWith({ taskSort: "manual" });
  });

  it("draws the rows in the order they were placed", () => {
    renderOrdered("manual", boardWith({ tasks: [first, second, { ...third, position: 0.5 }] }));

    expect(titles()).toEqual(["Third made", "First made", "Second made"]);
  });

  it("Alt+↓ moves a row one place down — written as its new place, between its new neighbours", () => {
    const { board } = renderOrdered("manual");

    fireEvent.keyDown(screen.getByRole("button", { name: "First made" }), { key: "ArrowDown", altKey: true });

    // Below `Second made` (2) and above `Third made` (3).
    expect(board.editTask).toHaveBeenCalledWith("a", { position: 2.5 });
  });

  it("moves nothing in any other sort — there, the order is not the person's to set", () => {
    const { board } = renderOrdered("priority");

    fireEvent.keyDown(screen.getByRole("button", { name: "First made" }), { key: "ArrowDown", altKey: true });

    expect(board.editTask).not.toHaveBeenCalled();
  });
});

describe("ordering a vault by hand", () => {
  // The order lives on Lotus's side, in the layout: writing `order:` into ticket files would put a
  // field the human's Dataview board never reads into every commit obsidian-git makes.
  const vault: TrackerProject = {
    id: VAULT_PROJECT_ID, name: "orbit-vault", prefix: "", vocabulary: VAULT_VOCABULARY, capabilities: VAULT_CAPABILITIES,
    source: { kind: "obsidian", syncLine: "Obsidian · watching folder" },
  };
  const ticket = (file: string, number: number): TrackerTask => ({
    id: file, projectId: VAULT_PROJECT_ID, key: `TKT-${number}`, number, title: `Ticket ${number}`,
    status: "in-review" as TrackerTask["status"], priority: "none", createdAt: 1, updatedAt: 1,
  });
  const tickets = [ticket("TKT-1.md", 1), ticket("TKT-2.md", 2), ticket("TKT-3.md", 3)];

  function renderVault(ticketOrder: Record<string, number> = {}) {
    const onLayoutChange = vi.fn();
    const board = boardWith({
      projects: [vault],
      projectsById: new Map([[vault.id, vault]]),
      tasks: tickets,
    });
    render(
      <TasksSurface vault={{ path: "/vault", connect: () => {}, disconnect: () => {} }} spawner={null}
        activities={new Map()} board={board}
        layout={{ ...DEFAULT_LAYOUT, taskSort: "manual", ticketOrder }}
        onLayoutChange={onLayoutChange} onClose={vi.fn()} />,
    );
    return { board, onLayoutChange };
  }

  it("Alt+↓ keeps the new place in the layout, and writes nothing to the vault", () => {
    const { board, onLayoutChange } = renderVault();

    fireEvent.keyDown(screen.getByRole("button", { name: "Ticket 1" }), { key: "ArrowDown", altKey: true });

    // Keyed by source as well as file: two sources can each hold a `TKT-1.md`.
    expect(onLayoutChange).toHaveBeenCalledWith({ ticketOrder: { "vault:TKT-1.md": 2.5 } });
    expect(board.editTask).not.toHaveBeenCalled();
  });

  it("draws the tickets in the order kept under the source's key", () => {
    renderVault({ "vault:TKT-3.md": 0.5 });

    expect(titles()).toEqual(["Ticket 3", "Ticket 1", "Ticket 2"]);
  });

  it("carries an order kept before sources existed over to the source's key on the next move", () => {
    const { onLayoutChange } = renderVault({ "TKT-3.md": 0.5, "gone.md": 9 });

    fireEvent.keyDown(screen.getByRole("button", { name: "Ticket 1" }), { key: "ArrowDown", altKey: true });

    // The legacy place is kept under its new key; the file no longer in the vault is dropped.
    expect(onLayoutChange).toHaveBeenCalledWith({
      ticketOrder: expect.objectContaining({ "vault:TKT-3.md": 0.5 }),
    });
    const written = onLayoutChange.mock.calls[0][0].ticketOrder as Record<string, number>;
    expect(written).toHaveProperty(["vault:TKT-1.md"]);
    expect(Object.keys(written).every((key) => key.startsWith("vault:"))).toBe(true);
  });

  it("draws the tickets in the order that was kept", () => {
    renderVault({ "TKT-3.md": 0.5 });

    expect(titles()).toEqual(["Ticket 3", "Ticket 1", "Ticket 2"]);
  });
});
