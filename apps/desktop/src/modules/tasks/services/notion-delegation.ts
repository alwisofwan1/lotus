import type { TaskSource } from "@/modules/codespace/services/bridge/task-store";
import { TASK_GOAL_CAP, TASK_TITLE_CAP, cutToBytes } from "@/modules/tasks/services/task-draft";
import type { NotionRow } from "@/modules/tasks/services/notion-source";

/**
 * Delegating a Notion ticket (PLAN S35, task "Ticket Sources 07").
 *
 * The agent reads the ticket from Notion itself, through Notion's hosted MCP signed in as the
 * person (PLAN S15) — Lotus's own token never reaches it. It must not WRITE there, and that is not
 * left to the prompt: every Notion MCP tool that creates, changes, moves or comments is denied on
 * the agent's command line, so the tools are not even in its context.
 */

/**
 * The Notion MCP tools that write or change anything, from
 * https://developers.notion.com/guides/mcp/mcp-supported-tools (checked 2026-09-28). Session tools
 * are here too: they start and steer Notion's own agents, which can write.
 */
export const NOTION_MCP_WRITE_TOOLS: readonly string[] = [
  "notion-create-file-upload",
  "notion-create-attachment",
  "notion-create-pages",
  "notion-update-page",
  "notion-convert-page-to-skill",
  "notion-move-pages",
  "notion-duplicate-page",
  "notion-create-database",
  "notion-create-folder",
  "notion-update-data-source",
  "notion-create-view",
  "notion-update-view",
  "notion-create-comment",
  "notion-spawn-session",
  "notion-send-message-to-session",
  "notion-wait-session",
  "notion-stop-session",
];

/**
 * Deny rules for those tools on ANY MCP server name. The server is whatever the person called it
 * (`notion`, `notionApi`, or `claude_ai_Notion` for the claude.ai connector); a glob in the
 * tool-name position matches the full name whatever it is (Claude Code permissions, "Tool name
 * wildcards"), and a matched tool is removed from the agent's context.
 */
export const NOTION_WRITE_DENY_RULES: readonly string[] = NOTION_MCP_WRITE_TOOLS.map((tool) => `mcp__*__${tool}`);

/** A Notion ticket as a workable Lotus task, made ALONGSIDE it — nothing is written to Notion. */
export function taskDraftFromNotionRow(
  row: NotionRow,
  sourceName: string,
  /** The page body as Notion sent it, when it was read. The agent reads the page itself either way. */
  body?: string | null,
): { title: string; goal: string; knowledge: string; source: TaskSource } {
  const name = row.key ?? row.title;
  const title = cutToBytes(`${row.key ? `${row.key} — ` : ""}${row.title || "Untitled"}`.trim(), TASK_TITLE_CAP);
  const where = row.url ? ` Read it first: ${row.url}` : "";
  const goal = cutToBytes(`Work ${name} from the Notion board ${sourceName}.${where}`, TASK_GOAL_CAP);

  const knowledge = [
    "## Notion ticket",
    [
      row.url ? `- Page: ${row.url}` : null,
      `- Board: ${sourceName}`,
      row.assignees.length ? `- Assignee: ${row.assignees.join(", ")}` : null,
      row.labels.length ? `- Labels: ${row.labels.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    "## Before you start",
    [
      "Read this page with the Notion MCP tool `notion-fetch` before starting — its description and",
      "acceptance criteria there are the latest, and win over anything copied below.",
      "Do not write to Notion: no status changes, comments, new pages or edits. Report back here instead.",
    ].join("\n"),
    body?.trim() ? `## Page, as read when delegated\n\n${body.trim()}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    title,
    goal,
    knowledge,
    // The page id, not the key: the id survives a renumbered key, and it is what reopens the row.
    source: { kind: "notion", ref: row.pageId, label: row.key ?? cutToBytes(row.title, 60) },
  };
}
