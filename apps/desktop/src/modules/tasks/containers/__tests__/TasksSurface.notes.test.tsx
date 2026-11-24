import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import { NOTION_CAPABILITIES, notionVocabulary, type NotionRow, type NotionSourceClient } from "@/modules/tasks/services/notion-source";
import { VAULT_CAPABILITIES } from "@/modules/tasks/services/vault-mapping";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import type { OpenedTask, TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import type { VaultTicketDetail } from "@/modules/tasks/services/vault-api";

/**
 * "Match notes by key" (PLAN S37, task "Ticket Sources 10"): a Notion ticket with a vault note of the
 * same key wears "notes" in the list and opens that note from its Notes section. Without a vault,
 * or with the option off, nothing on screen mentions notes (SOURCES 05).
 */

const statuses = { options: [{ id: "todo", name: "Todo", color: null }], groups: [{ id: "g1", name: "To-do", optionIds: ["todo"] }] };
const notionBoard = (matchesNotes: boolean): TrackerProject => ({
  id: "notion-abc",
  name: "TKT board",
  prefix: "",
  vocabulary: notionVocabulary(statuses),
  capabilities: NOTION_CAPABILITIES,
  source: { kind: "notion", syncLine: "Notion · synced 09:30", ...(matchesNotes ? { matchesNotes: true } : {}) },
});
const vault: TrackerProject = {
  id: "vault",
  name: "orbit-vault",
  prefix: "",
  vocabulary: VAULT_VOCABULARY,
  capabilities: VAULT_CAPABILITIES,
  source: { kind: "obsidian", syncLine: "Obsidian · watching folder" },
};
const row = (pageId: string, key: string, title: string): NotionRow => ({
  pageId, url: null, key, title, status: "todo", assignees: [], assigneeIds: [], labels: [], parents: [],
  createdTime: "2026-09-01T10:00:00.000Z", lastEditedTime: "2026-09-02T10:00:00.000Z",
});
const withNote = row("p1", "TKT-1008", "Stripe webhook environments");
const withoutNote = row("p2", "TKT-1010", "Invoice rounding");
const listed = (r: NotionRow): TrackerTask => ({
  id: r.pageId, projectId: "notion-abc", key: r.key!, title: r.title, status: "todo" as TrackerTask["status"],
  priority: "none", createdAt: 1, updatedAt: 1,
});
const note: TrackerTask = {
  id: "TKT-1008.md", projectId: "vault", key: "TKT-1008", title: "Stripe webhook (my notes)",
  status: "todo" as TrackerTask["status"], priority: "none", createdAt: 1, updatedAt: 1,
};
const noteDetail: VaultTicketDetail = {
  ticket: { file: "TKT-1008.md", ticket: "TKT-1008", title: "Stripe webhook (my notes)", status: "todo", tags: [], modifiedAt: 1 },
  sections: [{ heading: "Research", body: "The endpoint is shared." }],
  revision: "r1",
};

function renderSurface({ matchesNotes = true, withVault = true } = {}) {
  const board = notionBoard(matchesNotes);
  const projects = [board, ...(withVault ? [vault] : [])];
  const openTask = vi.fn(async (projectId: string, id: string): Promise<OpenedTask | null> => {
    if (projectId === "vault") return { kind: "ticket", detail: noteDetail };
    return { kind: "notion", projectId, row: id === "p1" ? withNote : withoutNote };
  });
  const fake: TrackerBoard = {
    projects,
    projectsById: new Map(projects.map((p) => [p.id, p])),
    tasks: [listed(withNote), listed(withoutNote), ...(withVault ? [note] : [])],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => null),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    openTask,
  };
  const notionClient = {
    pageMarkdown: vi.fn(async () => ({ markdown: "Body.", truncated: false, unknownBlockIds: [] })),
  } as unknown as NotionSourceClient;
  render(
    <TasksSurface
      vault={{ path: withVault ? "/v/orbit-vault" : "", connect: vi.fn(), disconnect: vi.fn() }}
      spawner={null}
      activities={new Map()}
      board={fake}
      layout={DEFAULT_LAYOUT}
      onLayoutChange={vi.fn()}
      onClose={vi.fn()}
      notionClient={notionClient}
    />,
  );
  return { openTask };
}

const listRow = (title: string) => screen.getByRole("button", { name: title }).closest(".tk-row") as HTMLElement;

describe("Notion tickets matched with vault notes by key", () => {
  it("puts \"notes\" on the ticket whose key has a note, and on no other", () => {
    renderSurface();
    expect(within(listRow("Stripe webhook environments")).getByText("notes")).toBeTruthy();
    expect(within(listRow("Invoice rounding")).queryByText("notes")).toBeNull();
    // The note itself is a vault row, not a matched ticket.
    expect(within(listRow("Stripe webhook (my notes)")).queryByText("notes")).toBeNull();
  });

  it("shows a Notes section that opens the matching note", async () => {
    const { openTask } = renderSurface();
    fireEvent.click(screen.getByRole("button", { name: "Stripe webhook environments" }));
    const properties = within(await screen.findByRole("complementary", { name: "Properties" }));
    expect(properties.getByRole("heading", { name: "Notes" })).toBeTruthy();
    expect(properties.getByText("Your Obsidian note for this ticket, matched by key.")).toBeTruthy();
    fireEvent.click(properties.getByRole("button", { name: /orbit-vault \/ TKT-1008\.md/ }));

    expect(await screen.findByText("The endpoint is shared.")).toBeTruthy();
    expect(openTask).toHaveBeenLastCalledWith("vault", "TKT-1008.md");
  });

  it("gives a ticket with no note no Notes section", async () => {
    renderSurface();
    fireEvent.click(screen.getByRole("button", { name: "Invoice rounding" }));
    const properties = within(await screen.findByRole("complementary", { name: "Properties" }));
    expect(properties.queryByRole("heading", { name: "Notes" })).toBeNull();
  });

  it.each([
    ["the option is off", { matchesNotes: false }],
    ["there is no vault", { withVault: false }],
  ])("leaves no trace of notes when %s", async (_why, options) => {
    renderSurface(options);
    expect(screen.queryByText("notes")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stripe webhook environments" }));
    const properties = within(await screen.findByRole("complementary", { name: "Properties" }));
    expect(properties.queryByRole("heading", { name: "Notes" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/notes/i);
  });
});
