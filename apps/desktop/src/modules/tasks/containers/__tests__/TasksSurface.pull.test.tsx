import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import { NOTION_CAPABILITIES, notionVocabulary, type NotionRow, type NotionSourceClient } from "@/modules/tasks/services/notion-source";
import { VAULT_CAPABILITIES } from "@/modules/tasks/services/vault-mapping";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import type { OpenedTask, TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import type { TicketEditOutcome, TicketEdits, VaultTicketDetail } from "@/modules/tasks/services/vault-api";

/**
 * Refreshing a vault note from its Notion page (PLAN S38, task "Ticket Sources 11", mockups
 * NOTION 02 and 03): a note that Notion moved past says so, the change is reviewed as a diff, and
 * only then is the note's `From Notion` section written — through the vault's own edit path.
 */

const statuses = { options: [{ id: "todo", name: "Todo", color: null }], groups: [{ id: "g1", name: "To-do", optionIds: ["todo"] }] };
const PAGE = "3e42eae0-39e4-80cc-b605-c8e01836e1e2";
const notionBoard = (matchesNotes: boolean): TrackerProject => ({
  id: "notion-abc",
  name: "TKT board",
  prefix: "",
  vocabulary: notionVocabulary(statuses),
  capabilities: NOTION_CAPABILITIES,
  source: { kind: "notion", syncLine: "Notion · synced", ...(matchesNotes ? { matchesNotes: true } : {}) },
});
const vault: TrackerProject = {
  id: "vault", name: "orbit-vault", prefix: "", vocabulary: VAULT_VOCABULARY, capabilities: VAULT_CAPABILITIES,
  source: { kind: "obsidian", syncLine: "Obsidian · watching folder" },
};
const notionRow: NotionRow = {
  pageId: PAGE, url: `https://www.notion.so/${PAGE.replace(/-/g, "")}`, key: "TKT-1008", title: "Stripe webhook", status: "todo",
  assignees: [], assigneeIds: [], labels: [], parents: [], createdTime: "2026-09-20T10:00:00.000Z",
  lastEditedTime: "2026-09-28T06:12:00.000Z",
};
const tasks: TrackerTask[] = [
  { id: PAGE, projectId: "notion-abc", key: "TKT-1008", title: "Stripe webhook", status: "todo" as TrackerTask["status"], priority: "none", createdAt: 1, updatedAt: 1 },
  { id: "TKT-1008.md", projectId: "vault", key: "TKT-1008", title: "Stripe webhook (note)", status: "todo" as TrackerTask["status"], priority: "none", createdAt: 1, updatedAt: 1 },
];
const note = (pulled: string | null, notion?: string): VaultTicketDetail => ({
  ticket: { file: "TKT-1008.md", ticket: "TKT-1008", title: "Stripe webhook (note)", status: "todo", tags: [], modifiedAt: 1, notionPulled: pulled, ...(notion ? { notion } : {}) },
  sections: [
    { heading: "From Notion", body: "- AC1 tag events\n- AC2 ignore foreign events" },
    { heading: "Summary", body: "My own words." },
    { heading: "Research", body: "Stripe sends to every endpoint." },
  ],
  revision: "r1",
});

function renderSurface({
  matchesNotes = true,
  detail = note("2026-09-26T02:40:00.000Z"),
  save = vi.fn(async (): Promise<TicketEditOutcome> => ({ kind: "saved", detail: note("2026-09-28T06:12:00.000Z") })),
  markdown = "## Acceptance\n- AC1 tag events\n- AC2 answer 200 and drop foreign events\n- AC4 count dropped events",
}: {
  matchesNotes?: boolean;
  detail?: VaultTicketDetail;
  save?: (file: string, base: string, edits: TicketEdits) => Promise<TicketEditOutcome>;
  markdown?: string;
} = {}) {
  const board = notionBoard(matchesNotes);
  const projects = [board, vault];
  const openTask = vi.fn(async (projectId: string): Promise<OpenedTask | null> =>
    projectId === "vault" ? { kind: "ticket", detail } : { kind: "notion", projectId, row: notionRow },
  );
  const fake: TrackerBoard = {
    projects,
    projectsById: new Map(projects.map((p) => [p.id, p])),
    tasks,
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => null),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    openTask,
    saveTicket: save,
    notionRows: {
      rowOf: (_projectId: string, pageId: string) => (pageId === PAGE ? notionRow : null),
      peopleOf: () => [], labelsOf: () => [], applyRow: vi.fn(), removeRow: vi.fn(), putRow: vi.fn(),
      subTicketsOf: () => 0, childrenOf: () => [],
    },
  };
  const pageMarkdown = vi.fn(async () => ({ markdown, truncated: false, unknownBlockIds: [] }));
  // The page moved on since the board's last sync: the pull must be stamped with THIS time.
  const pageEditedTime = vi.fn(async () => "2026-09-28T06:14:00.000Z");
  const notionClient = { pageMarkdown, pageEditedTime } as unknown as NotionSourceClient;
  render(
    <TasksSurface
      vault={{ path: "/v/orbit-vault", connect: vi.fn(), disconnect: vi.fn() }}
      spawner={null}
      activities={new Map()}
      board={fake}
      layout={DEFAULT_LAYOUT}
      onLayoutChange={vi.fn()}
      onClose={vi.fn()}
      notionClient={notionClient}
    />,
  );
  return { save, pageMarkdown };
}

async function openNote() {
  fireEvent.click(screen.getByRole("button", { name: "Stripe webhook (note)" }));
  return within(await screen.findByRole("complementary", { name: "Properties" }));
}

describe("a vault note refreshed from its Notion page", () => {
  it("says Notion changed since the last pull, and keeps the pulled section read only", async () => {
    renderSurface();
    const properties = await openNote();
    expect(screen.getByText("Notion changed since your last pull")).toBeTruthy();
    expect(properties.getByText("Notion is newer")).toBeTruthy();
    expect(properties.getByText(/^Pulled /)).toBeTruthy();
    expect(screen.getByText(/Written by Lotus on each pull/)).toBeTruthy();
  });

  it("shows the change as a diff, and writes only the From Notion section, stamped with the page's own edit time", async () => {
    const { save, pageMarkdown } = renderSurface();
    await openNote();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));

    const sheet = within(await screen.findByRole("dialog"));
    expect(sheet.getByText("Refresh TKT-1008 from Notion")).toBeTruthy();
    expect(sheet.getByText(/Summary and Research stay exactly as they are/)).toBeTruthy();
    const diff = within(await sheet.findByRole("list", { name: /Changes to the From Notion section/ }));
    expect(diff.getByText("- AC2 ignore foreign events").closest("[data-kind]")?.getAttribute("data-kind")).toBe("removed");
    expect(diff.getByText("- AC4 count dropped events").closest("[data-kind]")?.getAttribute("data-kind")).toBe("added");
    expect(pageMarkdown).toHaveBeenCalledWith(PAGE);

    fireEvent.click(sheet.getByRole("button", { name: "Update the vault note" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith("TKT-1008.md", "r1", {
      ownedSection: {
        heading: "From Notion",
        body: "### Acceptance\n\n- AC1 tag events\n- AC2 answer 200 and drop foreign events\n- AC4 count dropped events",
      },
      notionPulled: "2026-09-28T06:14:00.000Z",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the sheet open and says so when Obsidian changed the note in between", async () => {
    const save = vi.fn(async (): Promise<TicketEditOutcome> => ({ kind: "conflict", detail: note("2026-09-26T02:40:00.000Z") }));
    renderSurface({ save });
    await openNote();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const sheet = within(await screen.findByRole("dialog"));
    await sheet.findByRole("list", { name: /Changes/ });
    fireEvent.click(sheet.getByRole("button", { name: "Update the vault note" }));
    expect(await sheet.findByText(/changed in Obsidian a moment ago, so nothing was written/)).toBeTruthy();
  });

  it("only moves the pulled time on when Notion changed nothing but properties", async () => {
    const { save } = renderSurface({ markdown: "- AC1 tag events\n- AC2 ignore foreign events" });
    await openNote();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const sheet = within(await screen.findByRole("dialog"));
    expect(await sheet.findByText(/only its properties changed in Notion/)).toBeTruthy();
    fireEvent.click(sheet.getByRole("button", { name: "Mark as up to date" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("TKT-1008.md", "r1", { notionPulled: "2026-09-28T06:14:00.000Z" }));
  });

  it("says nothing when the note already holds Notion's latest version", async () => {
    renderSurface({ detail: note("2026-09-28T06:12:00.000Z") });
    const properties = await openNote();
    expect(screen.queryByText("Notion changed since your last pull")).toBeNull();
    expect(properties.queryByText("Notion is newer")).toBeNull();
    expect(properties.getByRole("button", { name: /Refresh from Notion/ })).toBeTruthy();
  });

  it("finds the page by the note's notion: link when matching by key is off", async () => {
    renderSurface({ matchesNotes: false, detail: note(null, `https://app.notion.com/p/acme/Stripe-webhook-${PAGE.replace(/-/g, "")}?v=1`) });
    const properties = await openNote();
    expect(properties.getByText("Not pulled yet")).toBeTruthy();
    expect(properties.getByRole("button", { name: /Pull from Notion/ })).toBeTruthy();
  });

  it("offers no pull for a note with no Notion page it can reach", async () => {
    renderSurface({ matchesNotes: false });
    const properties = await openNote();
    expect(properties.queryByRole("button", { name: /from Notion/ })).toBeNull();
    expect(screen.queryByText(/Written by Lotus/)).toBeNull();
  });
});
