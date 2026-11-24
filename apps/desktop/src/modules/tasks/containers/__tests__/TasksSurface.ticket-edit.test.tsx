import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { VAULT_CAPABILITIES, VAULT_PROJECT_ID } from "@/modules/tasks/services/vault-mapping";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TicketEditOutcome, TicketEdits, VaultTicketDetail } from "@/modules/tasks/services/vault-api";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * Editing a vault ticket from the page, down to the exact edit the board is asked to write.
 * The Rust side's surgery is tested in `vault_ticket_edit.rs`; this is that the page asks for it.
 */

const VAULT = { path: "/vault", connect: () => {}, disconnect: () => {} };
const lotus: TrackerProject = { id: "ws-1", name: "Workspace", prefix: "W", vocabulary: LOTUS_VOCABULARY };
const vault: TrackerProject = { id: VAULT_PROJECT_ID, name: "orbit-vault", prefix: "", vocabulary: VAULT_VOCABULARY, capabilities: VAULT_CAPABILITIES, source: { kind: "obsidian", syncLine: "Obsidian · watching folder" } };
const row: TrackerTask = {
  id: "TKT-1.md", projectId: VAULT_PROJECT_ID, key: "TKT-1", title: "Old title",
  status: "todo", priority: "none", createdAt: 1, updatedAt: 1,
};
const detail: VaultTicketDetail = {
  ticket: { file: "TKT-1.md", ticket: "TKT-1", title: "Old title", status: "todo", tags: [], modifiedAt: 1 },
  sections: [
    { heading: "Summary", body: "First line.\n\n| a | b |\n|---|---|\n| 1 | 2 |" },
    { heading: "Plan", body: "- [ ] one" },
  ],
  revision: "r1",
};

function setup() {
  const saveTicket = vi.fn(async (_file: string, _base: string, edits: TicketEdits): Promise<TicketEditOutcome> => ({
    kind: "saved",
    detail: {
      ...detail,
      ticket: { ...detail.ticket, ...(edits.status ? { status: edits.status } : {}), ...(edits.title ? { title: edits.title } : {}) },
      revision: "r2",
    },
  }));
  const board: TrackerBoard = {
    projects: [lotus, vault],
    projectsById: new Map([[lotus.id, lotus], [vault.id, vault]]),
    tasks: [row],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => null),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    openTask: vi.fn(async () => ({ kind: "ticket" as const, detail })),
    saveTicket,
    vaultVersion: 0,
  };
  render(
    <TasksSurface vault={VAULT} spawner={null} activities={new Map()} board={board}
      layout={DEFAULT_LAYOUT} onLayoutChange={vi.fn()} onClose={vi.fn()} />,
  );
  return { saveTicket };
}

async function openTicket() {
  fireEvent.click(screen.getByRole("button", { name: row.title }));
  await screen.findByRole("textbox", { name: "Ticket title" }, { timeout: 10_000 });
}

// The first test in this file pays for loading TipTap and ProseMirror cold; under a full parallel
// run that alone passed the 5 s default. The tests themselves take well under a second.
describe("editing a vault ticket in place", { timeout: 20_000 }, () => {
  it("writes a status change at once, as the vault's own word", async () => {
    const { saveTicket } = setup();
    await openTicket();
    fireEvent.click(screen.getByLabelText("Status: Todo"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "In Progress" }));
    await waitFor(() => expect(saveTicket).toHaveBeenCalledWith("TKT-1.md", "r1", { status: "in-progress", sections: [] }));
  });

  it("Escape in the title puts it back and leaves the ticket open", async () => {
    const { saveTicket } = setup();
    await openTicket();
    const title = screen.getByRole("textbox", { name: "Ticket title" });
    title.textContent = "Half-typed";
    fireEvent.keyDown(title, { key: "Escape" });
    expect(title.textContent).toBe("Old title");
    expect(screen.getByRole("textbox", { name: "Ticket title" })).toBeTruthy();
    expect(saveTicket).not.toHaveBeenCalled();
  });

  it("writes the title when the field is left, and not before", async () => {
    const { saveTicket } = setup();
    await openTicket();
    const title = screen.getByRole("textbox", { name: "Ticket title" });
    title.textContent = "New title";
    expect(saveTicket).not.toHaveBeenCalled();
    fireEvent.blur(title);
    await waitFor(() => expect(saveTicket).toHaveBeenCalledWith("TKT-1.md", "r1", { title: "New title", sections: [] }));
  });

  it("autosaves prose after a pause, sending only that section — the table beside it untouched", async () => {
    const { saveTicket } = setup();
    await openTicket();
    // The editor mounts in an effect after the panel renders; wait for it rather than race it.
    const dom = await waitFor(() => {
      const el = document.querySelector(".tk-editor") as (HTMLElement & { editor?: Editor }) | null;
      if (!el?.editor) throw new Error("editor not mounted yet");
      return el;
    });

    vi.useFakeTimers();
    try {
      act(() => {
        dom.editor!.commands.insertContentAt(1, "Rewritten. ");
      });
      expect(saveTicket).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(saveTicket).toHaveBeenCalledWith("TKT-1.md", "r1", {
      sections: [{ index: 0, heading: "Summary", body: "Rewritten. First line.\n\n| a | b |\n|---|---|\n| 1 | 2 |" }],
    });
  });
});
