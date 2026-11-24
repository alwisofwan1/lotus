import type { FactoryNotionTicket } from "@/lib/tauri/graph-run";

/**
 * What a run's agents read of a Notion ticket (#168): its properties, then its page. Comments are
 * not read. Read only: the run never writes to Notion.
 */
export function notionTicketBody(text: Pick<FactoryNotionTicket, "properties" | "markdown" | "truncated">): string {
  const parts: string[] = [];
  if (text.properties.length > 0) {
    parts.push(["Properties:", ...text.properties.map(([name, value]) => `- ${name}: ${value}`)].join("\n"));
  }
  const page = text.markdown.trim();
  if (page) parts.push(page);
  if (text.truncated) parts.push("(The page is longer than this. Open it in Notion for the rest.)");
  return parts.join("\n\n");
}

const NOTION_REPO_KEY = "factory-notion-repo:";

/**
 * The repo id a Notion database's tickets were last built in: the code is not in Notion. New run
 * and the ticket panel's card share it.
 */
export function keptNotionRepo(sourceId: string): string | null {
  try {
    return window.localStorage.getItem(NOTION_REPO_KEY + sourceId);
  } catch {
    return null;
  }
}

export function keepNotionRepo(sourceId: string, repoId: string): void {
  try {
    window.localStorage.setItem(NOTION_REPO_KEY + sourceId, repoId);
  } catch {
    /* only a convenience */
  }
}

const NOTION_WORKSPACE_KEY = "factory-notion-workspace:";

/** The Workspace id a Notion database's runs were last started in (AC-1). */
export function keptNotionWorkspace(sourceId: string): string | null {
  try {
    return window.localStorage.getItem(NOTION_WORKSPACE_KEY + sourceId);
  } catch {
    return null;
  }
}

export function keepNotionWorkspace(sourceId: string, workspaceId: string): void {
  try {
    window.localStorage.setItem(NOTION_WORKSPACE_KEY + sourceId, workspaceId);
  } catch {
    /* only a convenience */
  }
}
