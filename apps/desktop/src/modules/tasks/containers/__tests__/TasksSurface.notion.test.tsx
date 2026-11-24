import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import { NOTION_CAPABILITIES, notionVocabulary, type NotionRow, type NotionSourceClient } from "@/modules/tasks/services/notion-source";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";
import { describeHealth, type SourceHealth } from "@/modules/tasks/services/source-health";
import type { useVaultPath } from "@/modules/tasks/hooks/useVaultPath";
import type { DataSourceSchema, NotionSourceConfig } from "@/modules/tasks/services/notion-source";

/** A Notion database in the tracker: its rows list like any source's, and open read only. */

const statuses = {
  options: [{ id: "todo", name: "Todo", color: null }],
  groups: [{ id: "g1", name: "To-do", optionIds: ["todo"] }],
};
const board: TrackerProject = {
  id: "notion-abc",
  name: "Orbit board",
  prefix: "",
  vocabulary: notionVocabulary(statuses),
  capabilities: NOTION_CAPABILITIES,
  source: { kind: "notion", syncLine: "Notion · synced 09:30" },
};
const notionRow: NotionRow = {
  pageId: "p1",
  url: "https://www.notion.so/p1",
  key: "TKT-1008",
  title: "Stripe webhook: tag events with their environment",
  status: "todo",
  assignees: ["Alwi"], assigneeIds: [],
  labels: ["billing"],
  parents: [],
  createdTime: "2026-09-01T10:00:00.000Z",
  lastEditedTime: "2026-09-02T10:00:00.000Z",
};
const listed: TrackerTask = {
  id: "p1", projectId: "notion-abc", key: "TKT-1008", number: 1008, title: notionRow.title,
  status: "todo" as TrackerTask["status"], priority: "none", createdAt: 1, updatedAt: 1,
};

const workspace: TrackerProject = { id: "w1", name: "lotus", prefix: "LOT", vocabulary: LOTUS_VOCABULARY };
const worked: TrackerTask = {
  id: "t9", projectId: "w1", number: 9, title: "TKT-1008 — Stripe webhook", status: "in-progress",
  priority: "none", createdAt: 1, updatedAt: 1, sourceRef: "p1",
};

function fakeBoard(overrides: Partial<TrackerBoard> = {}): TrackerBoard {
  return {
    projects: [workspace, board],
    projectsById: new Map([[workspace.id, workspace], [board.id, board]]),
    tasks: [listed, worked],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => null),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    openTask: vi.fn(async () => ({ kind: "notion" as const, projectId: "notion-abc", row: notionRow })),
    ...overrides,
  };
}

function renderSurface(
  removeSource = vi.fn(),
  forget = vi.fn(async () => undefined),
  boardOverrides: Partial<TrackerBoard> = {},
  { vault, describe, write, trash, create, writeBody, ...props }: {
    onOpenConnectors?: () => void;
    vault?: Partial<Pick<ReturnType<typeof useVaultPath>, "sources" | "addNotionSource">>;
    describe?: NotionSourceClient["describe"];
    write?: NotionSourceClient["write"];
    trash?: NotionSourceClient["trash"];
    create?: NotionSourceClient["create"];
    writeBody?: NotionSourceClient["writeBody"];
  } = {},
) {
  const notionClient: NotionSourceClient = {
    search: vi.fn(),
    describe: describe ?? vi.fn(),
    write: write ?? vi.fn(),
    trash: trash ?? vi.fn(),
    create: create ?? vi.fn(),
    writeBody: writeBody ?? vi.fn(),
    read: vi.fn(),
    forget,
    pageMarkdown: vi.fn(async () => ({
      markdown: '## Description\n\n<callout icon="💡">Staging and production share one endpoint.</callout>\n\n<unknown url="https://www.notion.so/x#b" alt="bookmark"/>',
      truncated: false,
      unknownBlockIds: ["b"],
    })),
  };
  render(
    <TasksSurface
      vault={{ path: "", connect: vi.fn(), disconnect: vi.fn(), removeSource, ...vault }}
      spawner={null}
      activities={new Map()}
      board={fakeBoard(boardOverrides)}
      layout={DEFAULT_LAYOUT}
      onLayoutChange={vi.fn()}
      onClose={vi.fn()}
      notionClient={notionClient}
      {...props}
    />,
  );
  return { removeSource, forget };
}

describe("a Notion ticket source in Tasks", () => {
  it("lists the source with its mark and sync line, and no trace of Obsidian", () => {
    renderSurface();
    const nav = within(screen.getByRole("navigation", { name: "Tasks navigation" }));
    const row = nav.getByRole("button", { name: /Orbit board/ });
    expect(within(row).getByText("Notion · synced 09:30")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/obsidian/i);
  });

  it("opens a row read only, with its status in the board's words and the way to Notion", async () => {
    renderSurface();
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));

    expect(await screen.findByRole("heading", { name: "Stripe webhook: tag events with their environment" })).toBeTruthy();
    const properties = within(screen.getByRole("complementary", { name: "Properties" }));
    expect(properties.getByText("Todo")).toBeTruthy();
    expect(properties.getByText("Alwi")).toBeTruthy();
    expect(properties.getByRole("button", { name: /Open in Notion/ })).toBeTruthy();
    expect(properties.getByText(/read only here/)).toBeTruthy();
    expect(properties.getByText("Notion · synced 09:30")).toBeTruthy();
  });

  it("draws the page body Notion returned, made plain, and says when part of it cannot be shown", async () => {
    renderSurface();
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));

    expect(await screen.findByRole("heading", { name: "Description" })).toBeTruthy();
    // A callout is drawn as Notion draws it: a box with its icon (notion-blocks.ts).
    expect(screen.getByText("Staging and production share one endpoint.").closest(".tk-md-callout")).toBeTruthy();
    expect(document.body.textContent).not.toContain("<callout");
    expect(screen.getByRole("note")).toHaveTextContent("Part of this page cannot be shown here");
    expect(screen.getByRole("button", { name: /Edit in Notion/ })).toBeTruthy();
  });

  it("removes the source from Tasks, and its kept copy, from the source's own view", async () => {
    const { removeSource, forget } = renderSurface();
    const nav = within(screen.getByRole("navigation", { name: "Tasks navigation" }));
    fireEvent.click(nav.getByRole("button", { name: /Orbit board/ }));

    fireEvent.click(screen.getByRole("button", { name: "Remove source" }));

    expect(removeSource).toHaveBeenCalledWith("notion-abc");
    await waitFor(() => expect(forget).toHaveBeenCalledWith("notion-abc"));
  });

  it("offers Delegate into a workspace, says the agent cannot write to Notion, and lists the work it became", async () => {
    renderSurface();
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));
    const properties = within(await screen.findByRole("complementary", { name: "Properties" }));

    expect(properties.getByText("in lotus")).toBeTruthy();
    expect(properties.getByText("The agent reads this page in Notion and cannot write to it.")).toBeTruthy();
    expect(properties.getByRole("button", { name: /LOT-9/ })).toBeTruthy();
  });

  it("a task made from a Notion ticket links back to it, with Notion's mark", async () => {
    const fromNotion = {
      id: "t9", workspaceId: "w1", number: 9, title: "TKT-1008 — Stripe webhook", goal: "g", knowledge: "",
      status: "in-progress", priority: "none", createdAt: 1, updatedAt: 1,
      source: { kind: "notion", ref: "p1", label: "TKT-1008" },
    } as unknown as BridgeTask;
    const openTask = vi.fn(async (projectId: string) =>
      projectId === "w1"
        ? { kind: "task" as const, task: fromNotion }
        : { kind: "notion" as const, projectId: "notion-abc", row: notionRow },
    );
    renderSurface(vi.fn(), vi.fn(async () => undefined), { openTask });
    fireEvent.click(screen.getByRole("button", { name: /^TKT-1008 — Stripe webhook$/ }));

    const back = await screen.findByRole("button", { name: "TKT-1008" });
    expect(back.closest(".tk-detail-source")?.querySelector('[data-source-kind="notion"]')).not.toBeNull();
    fireEvent.click(back);
    expect(await screen.findByText("The agent reads this page in Notion and cannot write to it.")).toBeTruthy();
  });
});

describe("a Notion source's health in Tasks (SOURCES 06)", () => {
  const at = new Date(2026, 8, 29, 13, 40).getTime();
  function withHealth(health: SourceHealth): Partial<TrackerBoard> {
    const view = describeHealth({ label: "Notion", name: board.name, health, syncing: false, syncedAtMs: at, nowMs: at + 60_000 });
    const sick: TrackerProject = { ...board, source: { kind: "notion", syncLine: view.line, health: view } };
    return { projects: [workspace, sick], projectsById: new Map([[workspace.id, workspace], [sick.id, sick]]) };
  }

  it("says the same state in the nav row and the list banner, keeps the rows, and Retry syncs", () => {
    const refresh = vi.fn();
    renderSurface(undefined, undefined, { ...withHealth({ state: "offline", message: "x" }), refresh });

    const nav = within(screen.getByRole("navigation", { name: "Tasks navigation" }));
    const row = nav.getByRole("button", { name: /Orbit board/ });
    expect(within(row).getByText("Notion · offline, showing 13:40")).toBeTruthy();
    expect(row.querySelector("[data-tone='warn']")).toBeTruthy();

    const banner = within(screen.getByRole("status", { name: "Orbit board" }));
    expect(banner.getByText("You are offline. Showing tickets as of 13:40.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stripe webhook: tag events/ })).toBeTruthy();

    fireEvent.click(banner.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("a lost token asks to reconnect, in Connectors", () => {
    const onOpenConnectors = vi.fn();
    renderSurface(undefined, undefined, withHealth({ state: "lost_access", why: "token" }), { onOpenConnectors });

    const banner = within(screen.getByRole("status", { name: "Orbit board" }));
    expect(banner.getByText(/Lotus can no longer see Orbit board/)).toBeTruthy();
    fireEvent.click(banner.getByRole("button", { name: "Reconnect" }));
    expect(onOpenConnectors).toHaveBeenCalled();
  });

  it("a healthy source has no banner", () => {
    renderSurface(undefined, undefined, withHealth({ state: "healthy" }));
    expect(screen.queryByRole("status", { name: "Orbit board" })).toBeNull();
  });
});

describe("remapping a Notion source's fields (task \"Ticket Sources 08\")", () => {
  const config: NotionSourceConfig = {
    id: "notion-abc",
    kind: "notion",
    name: "Orbit board",
    dataSourceId: "abc",
    url: null,
    mapping: { title: "title", key: null, status: "st", assignee: null, labels: null, parent: null },
    statuses,
    permission: "read_only",
  };
  // Status was deleted in Notion; a new status field "Stage" took its place.
  const now: DataSourceSchema = {
    id: "abc",
    title: "Orbit board",
    url: null,
    properties: [
      { id: "title", name: "Name", kind: "title", status: null, uniquePrefix: null, relationTarget: null },
      { id: "st2", name: "Stage", kind: "status", status: statuses, uniquePrefix: null, relationTarget: null },
    ],
  };
  const fieldsChanged = (() => {
    const at = Date.now();
    const view = describeHealth({
      label: "Notion",
      name: board.name,
      health: { state: "fields_changed", fields: [{ field: "status", nowKind: null }] },
      syncing: false,
      syncedAtMs: at,
      nowMs: at,
    });
    const sick: TrackerProject = { ...board, source: { kind: "notion", syncLine: view.line, health: view } };
    return { projects: [workspace, sick], projectsById: new Map([[workspace.id, workspace], [sick.id, sick]]) };
  })();

  it("Remap fields in the banner opens the fields as Notion has them now, and Save keeps the new mapping", async () => {
    const addNotionSource = vi.fn();
    const describe = vi.fn(async () => ({ schema: now, mapping: { ...config.mapping, status: "st2" } }));
    renderSurface(undefined, undefined, fieldsChanged, { vault: { sources: [config], addNotionSource }, describe });

    const banner = within(screen.getByRole("status", { name: "Orbit board" }));
    expect(banner.getByText(/The Status field was removed or changed type in Notion/)).toBeTruthy();
    fireEvent.click(banner.getByRole("button", { name: "Remap fields" }));

    const sheet = within(await screen.findByRole("dialog", { name: "Fields of Orbit board" }));
    expect(describe).toHaveBeenCalledWith("abc");
    // The old Status field is gone, so what Notion suggests now is offered in its place.
    expect(((await sheet.findByRole("combobox", { name: "Status" })) as HTMLSelectElement).value).toBe("st2");
    expect((sheet.getByRole("combobox", { name: "Title" }) as HTMLSelectElement).value).toBe("title");

    fireEvent.click(sheet.getByRole("button", { name: "Save fields" }));
    expect(addNotionSource).toHaveBeenCalledWith({ ...config, mapping: { ...config.mapping, status: "st2" }, statuses });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Fields of Orbit board" })).toBeNull());
  });

  it("what Lotus may change is set in the same sheet", async () => {
    const addNotionSource = vi.fn();
    const describe = vi.fn(async () => ({ schema: now, mapping: { ...config.mapping, status: "st2" } }));
    renderSurface(undefined, undefined, fieldsChanged, { vault: { sources: [config], addNotionSource }, describe });
    fireEvent.click(within(screen.getByRole("status", { name: "Orbit board" })).getByRole("button", { name: "Remap fields" }));
    const sheet = within(await screen.findByRole("dialog", { name: "Fields of Orbit board" }));

    fireEvent.click(await sheet.findByRole("radio", { name: /Manage/ }));
    fireEvent.click(sheet.getByRole("button", { name: "Save fields" }));

    expect(addNotionSource.mock.calls[0][0].permission).toBe("manage");
  });

  it("the fields can be changed at any time from the source's header", async () => {
    const describe = vi.fn(async () => ({ schema: now, mapping: { ...config.mapping, status: "st2" } }));
    renderSurface(undefined, undefined, {}, { vault: { sources: [config], addNotionSource: vi.fn() }, describe });
    const nav = within(screen.getByRole("navigation", { name: "Tasks navigation" }));
    fireEvent.click(nav.getByRole("button", { name: /Orbit board/ }));

    fireEvent.click(screen.getByRole("button", { name: "Fields" }));

    expect(await screen.findByRole("dialog", { name: "Fields of Orbit board" })).toBeTruthy();
  });
});

describe("the fields sheet keeps what the person picked", () => {
  it("does not read Notion again, or reset the form, when the settings change under it", async () => {
    const { NotionFieldsSheet } = await import("@/modules/tasks/components/NotionFieldsSheet");
    const source: NotionSourceConfig = {
      id: "notion-abc", kind: "notion", name: "Orbit board", dataSourceId: "abc", url: null,
      mapping: { title: "title", key: null, status: "st", assignee: null, labels: null, parent: null },
      statuses, permission: "read_only",
    };
    const schema: DataSourceSchema = {
      id: "abc", title: "Orbit board", url: null,
      properties: [
        { id: "title", name: "Name", kind: "title", status: null, uniquePrefix: null, relationTarget: null },
        { id: "st", name: "Status", kind: "status", status: statuses, uniquePrefix: null, relationTarget: null },
      ],
    };
    const client = { search: vi.fn(), describe: vi.fn(async () => ({ schema, mapping: source.mapping })), read: vi.fn(), forget: vi.fn(), pageMarkdown: vi.fn(), write: vi.fn(), writeBody: vi.fn(), create: vi.fn(), trash: vi.fn() };
    const { rerender } = render(<NotionFieldsSheet source={source} client={client} onSave={vi.fn()} onClose={vi.fn()} />);
    const status = (await screen.findByRole("combobox", { name: "Status" })) as HTMLSelectElement;
    fireEvent.change(status, { target: { value: "" } });

    // The same source, as a new object — what every settings event hands down.
    rerender(<NotionFieldsSheet source={{ ...source, mapping: { ...source.mapping } }} client={client} onSave={vi.fn()} onClose={vi.fn()} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(client.describe).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("combobox", { name: "Status" }) as HTMLSelectElement).value).toBe("");
  });
});

describe("a ticket in a Manage database, from Tasks (task \"Ticket Sources 09\")", () => {
  const managed: NotionSourceConfig = {
    id: "notion-abc", kind: "notion", name: "Orbit board", dataSourceId: "abc", url: null,
    mapping: { title: "title", key: null, status: "st", assignee: "pp", labels: null, parent: null },
    statuses, permission: "manage",
  };

  it("changes the status through the source, and the list gets Notion's answer", async () => {
    const saved = { ...notionRow, status: "todo", title: "Renamed" };
    const write = vi.fn(async () => ({ outcome: "saved" as const, row: saved }));
    const applyRow = vi.fn();
    const notionRows = { peopleOf: () => [{ id: "u1", name: "Alwi" }], labelsOf: () => [], applyRow, rowOf: () => null, removeRow: vi.fn(), putRow: vi.fn(), subTicketsOf: () => 0, childrenOf: () => [] };
    renderSurface(undefined, undefined, { notionRows }, { vault: { sources: [managed] }, write });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));

    const title = await screen.findByRole("textbox", { name: "Title" });
    title.textContent = "Renamed";
    fireEvent.blur(title);

    await waitFor(() => expect(write).toHaveBeenCalledWith("notion-abc", { field: "title", value: "Renamed" }, notionRow));
    await waitFor(() => expect(applyRow).toHaveBeenCalledWith("notion-abc", saved));
  });

  it("the open ticket shows the list's current copy of it", async () => {
    const newer = { ...notionRow, title: "Edited in Notion a minute ago" };
    const notionRows = { peopleOf: () => [], labelsOf: () => [], applyRow: vi.fn(), rowOf: () => newer, removeRow: vi.fn(), putRow: vi.fn(), subTicketsOf: () => 0, childrenOf: () => [] };
    renderSurface(undefined, undefined, { notionRows }, { vault: { sources: [managed] } });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));
    expect((await screen.findByRole("textbox", { name: "Title" })).textContent).toBe("Edited in Notion a minute ago");
  });

  it("a Read only source opens with nothing to change", async () => {
    renderSurface(undefined, undefined, {}, { vault: { sources: [{ ...managed, permission: "read_only" }] } });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));
    await screen.findByRole("heading", { name: notionRow.title });
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Status" })).toBeNull();
  });
});

describe("moving a Notion ticket to trash, and Undo (task \"Ticket Sources 14\")", () => {
  const managed: NotionSourceConfig = {
    id: "notion-abc", kind: "notion", name: "Orbit board", dataSourceId: "abc", url: null,
    mapping: { title: "title", key: null, status: "st", assignee: null, labels: null, parent: "par" },
    statuses, permission: "manage",
  };
  function rows(overrides: Record<string, unknown> = {}) {
    return { peopleOf: () => [], labelsOf: () => [], applyRow: vi.fn(), rowOf: () => null, removeRow: vi.fn(), putRow: vi.fn(), subTicketsOf: () => 3, childrenOf: () => [], ...overrides };
  }

  it("asks first, names the sub-tickets that stay, then the ticket leaves the list and Undo is offered", async () => {
    const trash = vi.fn(async () => ({ outcome: "saved" as const, row: notionRow }));
    const notionRows = rows();
    renderSurface(undefined, undefined, { notionRows }, { vault: { sources: [managed] }, trash });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));

    fireEvent.click(await screen.findByRole("button", { name: "Move to trash" }));
    const dialog = within(screen.getByRole("dialog", { name: "Move TKT-1008 to trash?" }));
    expect(dialog.getByText(/It has 3 sub-tickets\. They stay as they are — only TKT-1008 moves to trash\./)).toBeTruthy();
    expect(trash).not.toHaveBeenCalled();

    fireEvent.click(dialog.getByRole("button", { name: "Move to trash" }));

    await waitFor(() => expect(trash).toHaveBeenCalledWith("notion-abc", "p1", true));
    expect(notionRows.removeRow).toHaveBeenCalledWith("notion-abc", "p1");
    const toast = within(await screen.findByRole("status", { name: "Moved to trash" }));
    expect(toast.getByText("TKT-1008 moved to trash in Notion")).toBeTruthy();
    // Back on the list: the ticket is gone from the screen at once, not at the next full read.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Undo puts it back, in Notion and in the list", async () => {
    const trash = vi.fn(async () => ({ outcome: "saved" as const, row: notionRow }));
    const notionRows = rows();
    renderSurface(undefined, undefined, { notionRows }, { vault: { sources: [managed] }, trash });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Move to trash" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move to trash" }));
    const toast = within(await screen.findByRole("status", { name: "Moved to trash" }));

    fireEvent.click(toast.getByRole("button", { name: /Undo/ }));

    await waitFor(() => expect(trash).toHaveBeenLastCalledWith("notion-abc", "p1", false));
    await waitFor(() => expect(notionRows.putRow).toHaveBeenCalledWith("notion-abc", notionRow));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Moved to trash" })).toBeNull());
  });

  it("a refused trash says why, and the ticket stays", async () => {
    const trash = vi.fn(async () => ({ outcome: "refused" as const, message: "Notion refused the change: restricted_resource: no" }));
    const notionRows = rows({ subTicketsOf: () => 0 });
    renderSurface(undefined, undefined, { notionRows }, { vault: { sources: [managed] }, trash });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Move to trash" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.queryByText(/sub-tickets/)).toBeNull();

    fireEvent.click(dialog.getByRole("button", { name: "Move to trash" }));

    expect((await dialog.findByRole("alert")).textContent).toMatch(/restricted_resource/);
    expect(notionRows.removeRow).not.toHaveBeenCalled();
  });

  it("an Undo Notion refuses says so, and can be tried again", async () => {
    const trash = vi.fn(async (_s: string, _p: string, into: boolean) =>
      into ? { outcome: "saved" as const, row: notionRow } : { outcome: "refused" as const, message: "Changes are paused until the fields are remapped." },
    );
    const notionRows = rows();
    renderSurface(undefined, undefined, { notionRows }, { vault: { sources: [managed] }, trash });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Move to trash" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move to trash" }));
    const toast = within(await screen.findByRole("status", { name: "Moved to trash" }));

    fireEvent.click(toast.getByRole("button", { name: /Undo/ }));

    const failed = within(await screen.findByRole("status", { name: "Moved to trash" }));
    expect(await failed.findByText(/Could not undo.*paused until the fields are remapped/)).toBeTruthy();
    expect(failed.getByRole("button", { name: /Try again/ })).toBeTruthy();
    expect(notionRows.putRow).not.toHaveBeenCalled();
  });

  it("the dialog cannot be dismissed while the trash is on its way", async () => {
    let answer: (o: { outcome: "saved"; row: typeof notionRow }) => void = () => undefined;
    const trash = vi.fn(() => new Promise<{ outcome: "saved"; row: typeof notionRow }>((resolve) => (answer = resolve)));
    renderSurface(undefined, undefined, { notionRows: rows() }, { vault: { sources: [managed] }, trash });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Move to trash" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.getByRole("dialog")).toBeTruthy();
    answer({ outcome: "saved", row: notionRow });
    expect(await screen.findByRole("status", { name: "Moved to trash" })).toBeTruthy();
  });

  it("a Read only database offers no trash", async () => {
    renderSurface(undefined, undefined, { notionRows: rows() }, { vault: { sources: [{ ...managed, permission: "read_only" }] } });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));
    await screen.findByRole("heading", { name: notionRow.title });
    expect(screen.queryByRole("button", { name: "Move to trash" })).toBeNull();
  });
});

describe("new tickets and sub-tickets in a Manage database (task \"Ticket Sources 15\")", () => {
  const managed: NotionSourceConfig = {
    id: "notion-abc", kind: "notion", name: "Orbit board", dataSourceId: "abc", url: null,
    mapping: { title: "title", key: null, status: "st", assignee: null, labels: null, parent: "par" },
    statuses, permission: "manage",
  };
  const made = { ...notionRow, pageId: "p9", key: "TKT-1013", title: "Tag events", parents: ["p1"] };
  function rows(overrides: Record<string, unknown> = {}) {
    return { peopleOf: () => [], labelsOf: () => [], applyRow: vi.fn(), rowOf: () => null, removeRow: vi.fn(), putRow: vi.fn(), subTicketsOf: () => 0, childrenOf: () => [], ...overrides };
  }

  it("a sub-ticket added on the main ticket is created with it as Parent, and joins the list", async () => {
    const create = vi.fn(async () => ({ outcome: "saved" as const, row: made }));
    const notionRows = rows();
    renderSurface(undefined, undefined, { notionRows }, { vault: { sources: [managed] }, create });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));

    const input = await screen.findByRole("textbox", { name: "New sub-ticket title" });
    fireEvent.change(input, { target: { value: "Tag events" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(create).toHaveBeenCalledWith("notion-abc", "Tag events", "p1"));
    await waitFor(() => expect(notionRows.putRow).toHaveBeenCalledWith("notion-abc", made));
  });

  it("with no Parent field mapped, the main ticket says how to get sub-tickets", async () => {
    renderSurface(undefined, undefined, { notionRows: rows() }, { vault: { sources: [{ ...managed, mapping: { ...managed.mapping, parent: null } }] } });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));
    expect(await screen.findByText("Map a Parent field to add sub-tickets")).toBeTruthy();
  });

  it("New task on a Manage Notion source creates a ticket in that database and opens it", async () => {
    const create = vi.fn(async () => ({ outcome: "saved" as const, row: { ...made, parents: [] } }));
    const notionRows = rows();
    renderSurface(undefined, undefined, { notionRows }, { vault: { sources: [managed] }, create });
    const nav = within(screen.getByRole("navigation", { name: "Tasks navigation" }));
    fireEvent.click(nav.getByRole("button", { name: /Orbit board/ }));

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New ticket in Orbit board" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Title" }), { target: { value: "Tag events" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create ticket" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith("notion-abc", "Tag events", null));
    await waitFor(() => expect(notionRows.putRow).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New ticket in Orbit board" })).toBeNull());
  });

  it("a new ticket Notion may have created cannot be sent again; the way on is Refresh board", async () => {
    const create = vi.fn(async () => ({ outcome: "unknown" as const, message: "Notion may have created the ticket, but Lotus could not confirm it (timeout). Refresh before adding it again." }));
    const refresh = vi.fn();
    renderSurface(undefined, undefined, { notionRows: rows(), refresh }, { vault: { sources: [managed] }, create });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Tasks navigation" })).getByRole("button", { name: /Orbit board/ }));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New ticket in Orbit board" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Title" }), { target: { value: "Tag events" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create ticket" }));

    expect((await dialog.findByRole("alert")).textContent).toMatch(/may have created/);
    expect(dialog.queryByRole("button", { name: "Create ticket" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Refresh board" }));
    expect(refresh).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a Read only source adds nothing: no sub-ticket form", async () => {
    renderSurface(undefined, undefined, { notionRows: rows() }, { vault: { sources: [{ ...managed, permission: "read_only" }] } });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));
    await screen.findByRole("heading", { name: notionRow.title });
    expect(screen.queryByRole("textbox", { name: "New sub-ticket title" })).toBeNull();
  });
});

describe("editing a Notion ticket's body from Tasks (task \"Ticket Sources 13\")", () => {
  it("saves through the source, naming the page, what was opened and what was typed", async () => {
    const managed: NotionSourceConfig = {
      id: "notion-abc", kind: "notion", name: "Orbit board", dataSourceId: "abc", url: null,
      mapping: { title: "title", key: null, status: "st", assignee: null, labels: null, parent: null },
      statuses, permission: "manage",
    };
    const writeBody = vi.fn(async () => ({ outcome: "saved" as const, markdown: "## Description\n\nEdited.\n" }));
    const notionRows = { peopleOf: () => [], labelsOf: () => [], applyRow: vi.fn(), rowOf: () => null, removeRow: vi.fn(), putRow: vi.fn(), subTicketsOf: () => 0, childrenOf: () => [] };
    renderSurface(undefined, undefined, { notionRows }, { vault: { sources: [managed] }, writeBody });
    fireEvent.click(screen.getByRole("button", { name: /Stripe webhook: tag events/ }));

    // This board's page has an <unknown> block (see renderSurface), so it is not editable here.
    await screen.findByText(/blocks Lotus cannot show/);
    expect(screen.queryByRole("button", { name: "Edit body" })).toBeNull();
    expect(writeBody).not.toHaveBeenCalled();
  });
});
