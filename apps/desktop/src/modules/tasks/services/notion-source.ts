import { tauriInvoke } from "@/lib/tauri/runtime";
import { formatTaskKey, parseTaskKey } from "@/modules/tasks/services/task-key";
import type { SourceHealth } from "@/modules/tasks/services/source-health";
import type { StatusVocabulary, TaskStatusTone } from "@/modules/tasks/services/task-vocabulary";
import type { ProjectCapabilities, TrackerTask } from "@/modules/tasks/types";

/**
 * A Notion database as a ticket source (plans/ticket-sources §2.3–2.4, task "Ticket Sources 04").
 *
 * Everything that talks to Notion is in Rust (`notion_host.rs`); this file holds the shapes the
 * commands answer in, the words a board's statuses become, and how a Notion page becomes a row.
 */

/** Which property is which ticket field, by property ID — a rename in Notion changes nothing. */
export interface FieldMapping {
  title: string | null;
  key: string | null;
  status: string | null;
  assignee: string | null;
  labels: string | null;
  parent: string | null;
}

export interface StatusOption {
  id: string;
  name: string;
  color: string | null;
}
export interface StatusGroup {
  id: string;
  name: string;
  optionIds: string[];
}
export interface StatusSchema {
  options: StatusOption[];
  groups: StatusGroup[];
}

export interface PropertySchema {
  id: string;
  name: string;
  /** Notion's property type: `title`, `status`, `unique_id`, `people`, … */
  kind: string;
  status: StatusSchema | null;
  uniquePrefix: string | null;
  relationTarget: string | null;
}

export interface DataSourceSchema {
  id: string;
  title: string;
  url: string | null;
  properties: PropertySchema[];
}

export interface DataSourceSummary {
  id: string;
  title: string;
  url: string | null;
}

export interface NotionRow {
  pageId: string;
  url: string | null;
  key: string | null;
  title: string;
  /** The status option's id. */
  status: string | null;
  assignees: string[];
  /** The same people's user ids, in the same order — what a write sends back. */
  assigneeIds: string[];
  labels: string[];
  parents: string[];
  createdTime: string;
  lastEditedTime: string;
}

/**
 * A source after a sync (`notion_host::SourceSync`): its rows — the last good copy whenever Notion
 * could not be read, so a failing source never empties the list — and the state it is in.
 */
export interface SourceSync {
  rows: NotionRow[];
  /** When the last sync that worked started. */
  syncedAtMs: number | null;
  /** When every row was last read, rather than only the edited ones. */
  reconciledAtMs: number | null;
  complete: boolean;
  /** The board's fields as last read — its status options follow Notion without a remap (S20). */
  schema: DataSourceSchema | null;
  health: SourceHealth;
}

/** One field's new value (`lotus_automation::notion::write::TicketChange`). Key and rollups are never here. */
export type TicketChange =
  | { field: "title"; value: string }
  | { field: "status"; value: string }
  | { field: "assignees"; value: string[] }
  | { field: "labels"; value: string[] };

/** What a write came to (`WriteOutcome`). Every answer but `saved` leaves Notion as it was. */
export type WriteOutcome =
  | { outcome: "saved"; row: NotionRow }
  | { outcome: "conflict"; fresh: NotionRow }
  | { outcome: "refused"; message: string }
  | { outcome: "not_saved"; fresh: NotionRow; message: string }
  /** The write went out; whether Notion kept it could not be learned. Not repeated. */
  | { outcome: "unknown"; message: string };

/** What saving a page body came to (`lotus_automation::notion::body::BodyOutcome`). */
export type BodyOutcome =
  | { outcome: "saved"; markdown: string }
  | { outcome: "conflict"; fresh: string }
  | { outcome: "refused"; message: string }
  | { outcome: "not_saved"; fresh: string; message: string }
  | { outcome: "unknown"; message: string };

/**
 * One Notion source as `~/.claude/settings.json` keeps it, in `ticketSources`.
 *
 * The status options are kept with it, so the board's words are known before — and without —
 * reaching Notion. They are refreshed whenever the database is described again.
 */
export interface NotionSourceConfig {
  id: string;
  kind: "notion";
  name: string;
  dataSourceId: string;
  url: string | null;
  mapping: FieldMapping;
  statuses: StatusSchema | null;
  /**
   * What Lotus may change here (PLAN S21). `read_only` by default. The token can always write, so it
   * is Lotus that keeps a Read only board read only — Rust reads this from settings before any write.
   */
  permission: "read_only" | "manage";
  /**
   * "Match notes by key" (PLAN S37): the owner asked for this board's tickets to be matched with
   * notes of the same key, wherever such notes are kept. This board only states the wish; the
   * matching is the ticket-source registry's (`ticket-sources.ts`). Absent means off.
   */
  matchNotes?: boolean;
}

/** Read only for now: Lotus lists and opens; nothing is written back (PLAN S21). */
export const NOTION_CAPABILITIES: ProjectCapabilities = {
  holdsTasks: false,
  editRows: false,
  // A manual order is Lotus's own, kept in the layout — never written to Notion.
  reorder: true,
  hasPriority: false,
};

/** The source id a database gets. Derived from the database, so the same one cannot be added twice. */
export function notionSourceId(dataSourceId: string): string {
  return `notion-${dataSourceId.replace(/[^0-9a-f]/gi, "").slice(0, 32)}`;
}

type GroupKind = "todo" | "progress" | "complete";

/*
  Notion's status property always has three groups: To-do, In progress, Complete. They are
  recognised by name and, failing that, by place — Notion lists them in that order.
*/
function groupKind(group: StatusGroup, index: number): GroupKind {
  const name = group.name.toLowerCase();
  if (name.includes("complete") || name.includes("done")) return "complete";
  if (name.includes("progress")) return "progress";
  if (name.includes("to-do") || name.includes("todo") || name.includes("to do")) return "todo";
  return index === 0 ? "todo" : index === 1 ? "progress" : "complete";
}

const GROUP_TONE: Record<GroupKind, TaskStatusTone> = { progress: "progress", todo: "open", complete: "done" };

/**
 * A board's statuses as the tracker speaks them (PLAN S20): the options' own names, never renamed,
 * with work in flight first and finished work last — the same principle Lotus's and the vault's
 * orders follow. To-do and In progress are open; Complete is closed.
 */
export function notionVocabulary(statuses: StatusSchema | null): StatusVocabulary {
  if (!statuses || statuses.options.length === 0) {
    return { order: [], labels: {}, tones: {}, open: [] };
  }
  const byKind: Record<GroupKind, string[]> = { progress: [], todo: [], complete: [] };
  const grouped = new Set<string>();
  statuses.groups.forEach((group, index) => {
    for (const id of group.optionIds) {
      byKind[groupKind(group, index)].push(id);
      grouped.add(id);
    }
  });
  // An option in no group (should not happen) is treated as to-do rather than dropped.
  for (const option of statuses.options) if (!grouped.has(option.id)) byKind.todo.push(option.id);

  const known = new Set(statuses.options.map((option) => option.id));
  const order = [...byKind.progress, ...byKind.todo, ...byKind.complete].filter((id) => known.has(id));
  const labels: Record<string, string> = {};
  const tones: Record<string, TaskStatusTone> = {};
  for (const option of statuses.options) labels[option.id] = option.name;
  for (const kind of ["progress", "todo", "complete"] as GroupKind[]) {
    for (const id of byKind[kind]) tones[id] = GROUP_TONE[kind];
  }
  return { order, labels, tones, open: [...byKind.progress, ...byKind.todo].filter((id) => known.has(id)) };
}

/** A Notion page as a tracker row, keyed by page id in its source's project. */
export function toTrackerTaskFromNotionRow(row: NotionRow, projectId: string): TrackerTask {
  const parsed = row.key ? parseTaskKey(row.key) : null;
  const key = (parsed ? formatTaskKey(parsed.prefix, parsed.number) : null) ?? row.key;
  const created = Date.parse(row.createdTime);
  const edited = Date.parse(row.lastEditedTime);
  return {
    id: row.pageId,
    projectId,
    ...(parsed ? { number: parsed.number } : {}),
    ...(key ? { key } : {}),
    title: row.title || "Untitled",
    // Raw: the option's id. The board's words are its own (`notionVocabulary`).
    status: (row.status ?? "") as TrackerTask["status"],
    priority: "none",
    createdAt: Number.isNaN(created) ? 0 : created,
    updatedAt: Number.isNaN(edited) ? 0 : edited,
    assignees: row.assigneeIds.map((id, index) => ({ id, name: row.assignees[index] ?? "" })),
    labels: row.labels,
  };
}

/** A ticket's page body as Notion's markdown, read when the ticket is opened (PLAN S30). */
export interface PageMarkdown {
  markdown: string;
  truncated: boolean;
  unknownBlockIds: string[];
}

export interface NotionSourceClient {
  search(query: string): Promise<DataSourceSummary[]>;
  pageMarkdown(pageId: string): Promise<PageMarkdown>;
  /** A page's `last_edited_time`, read before its body on a pull. Optional: a test client may lack it. */
  pageEditedTime?(pageId: string): Promise<string>;
  describe(dataSourceId: string): Promise<{ schema: DataSourceSchema; mapping: FieldMapping }>;
  /** Changes one field of a ticket. Rust refuses unless the source is set to Manage in settings. */
  write(sourceId: string, change: TicketChange, seen: NotionRow): Promise<WriteOutcome>;
  /** Saves an edited page body: `seen` as opened, `markdown` as edited. Only changed pieces go. */
  writeBody(sourceId: string, pageId: string, seen: string, markdown: string): Promise<BodyOutcome>;
  /** Creates a ticket — a sub-ticket of `parent` when given. Notion gives it its key. */
  create(sourceId: string, title: string, parent: string | null): Promise<WriteOutcome>;
  /** Moves a ticket to Notion's trash (`trash`), or back — Undo. Never a permanent delete. */
  trash(sourceId: string, pageId: string, trash: boolean): Promise<WriteOutcome>;
  /** One sync. `full` reads every row, due or not — when the source appears or is refreshed by hand. */
  read(sourceId: string, dataSourceId: string, mapping: FieldMapping, options: { full: boolean }): Promise<SourceSync>;
  forget(sourceId: string): Promise<void>;
}

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function createTauriNotionSourceClient(invokeFn: InvokeFn = tauriInvoke as InvokeFn): NotionSourceClient {
  return {
    search: (query) => invokeFn<DataSourceSummary[]>("notion_search_data_sources", { query }),
    describe: (dataSourceId) =>
      invokeFn<{ schema: DataSourceSchema; mapping: FieldMapping }>("notion_describe_data_source", { dataSourceId }),
    read: (sourceId, dataSourceId, mapping, { full }) =>
      invokeFn<SourceSync>("notion_read_source", { sourceId, dataSourceId, mapping, full }),
    forget: (sourceId) => invokeFn<void>("notion_forget_source", { sourceId }),
    write: (sourceId, change, seen) => invokeFn<WriteOutcome>("notion_write_ticket", { sourceId, change, seen }),
    trash: (sourceId, pageId, trash) => invokeFn<WriteOutcome>("notion_trash_ticket", { sourceId, pageId, trash }),
    create: (sourceId, title, parent) => invokeFn<WriteOutcome>("notion_create_ticket", { sourceId, title, parent }),
    writeBody: (sourceId, pageId, seen, markdown) =>
      invokeFn<BodyOutcome>("notion_write_body", { sourceId, pageId, seen, markdown }),
    pageMarkdown: (pageId) => invokeFn<PageMarkdown>("notion_page_markdown", { pageId }),
    pageEditedTime: (pageId) => invokeFn<string>("notion_page_edited_time", { pageId }),
  };
}
