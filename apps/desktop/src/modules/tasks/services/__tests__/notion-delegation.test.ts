import { describe, expect, it } from "vitest";
import {
  NOTION_MCP_WRITE_TOOLS,
  NOTION_WRITE_DENY_RULES,
  taskDraftFromNotionRow,
} from "@/modules/tasks/services/notion-delegation";
import { denyToolsArgs, startCommand, withDeniedTools, type DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import type { NotionRow } from "@/modules/tasks/services/notion-source";

const row: NotionRow = {
  pageId: "248104cd-477e-80af-bc30-000bea2dd2a5",
  url: "https://www.notion.so/248104cd477e80afbc30000bea2dd2a5",
  key: "TKT-1008",
  title: "Stripe webhook: tag events with their environment",
  status: "progress",
  assignees: ["Alwi"], assigneeIds: [],
  labels: ["billing"],
  parents: [],
  createdTime: "2026-09-01T10:00:00.000Z",
  lastEditedTime: "2026-09-02T10:00:00.000Z",
};

describe("a Notion ticket, delegated", () => {
  it("becomes a task that points back at the page by id, named by its key", () => {
    const draft = taskDraftFromNotionRow(row, "Orbit board");
    expect(draft.source).toEqual({ kind: "notion", ref: row.pageId, label: "TKT-1008" });
    expect(draft.title).toBe("TKT-1008 — Stripe webhook: tag events with their environment");
  });

  it("tells the agent where the page is, to read it first, and not to write to Notion", () => {
    const draft = taskDraftFromNotionRow(row, "Orbit board", "## Description\n\nTag every event.");
    expect(draft.goal).toContain(row.url);
    expect(draft.knowledge).toContain(`- Page: ${row.url}`);
    expect(draft.knowledge).toContain("`notion-fetch`");
    expect(draft.knowledge).toContain("Do not write to Notion");
    expect(draft.knowledge).toContain("## Page, as read when delegated\n\n## Description\n\nTag every event.");
  });

  it("still works for a page with no key and no body", () => {
    const draft = taskDraftFromNotionRow({ ...row, key: null }, "Board", null);
    expect(draft.source.label).toBe(row.title);
    expect(draft.knowledge).not.toContain("Page, as read");
  });
});

describe("keeping a delegated agent from writing to Notion", () => {
  it("denies every Notion MCP tool that writes, on any server name", () => {
    expect(NOTION_MCP_WRITE_TOOLS).toHaveLength(17);
    expect(NOTION_WRITE_DENY_RULES).toContain("mcp__*__notion-update-page");
    expect(NOTION_WRITE_DENY_RULES).toContain("mcp__*__notion-create-comment");
    expect(NOTION_WRITE_DENY_RULES).not.toContain("mcp__*__notion-fetch");
    expect(NOTION_WRITE_DENY_RULES.every((rule) => rule.startsWith("mcp__*__notion-"))).toBe(true);
  });

  it("passes each rule as its own quoted argument, so the shell does not expand the *", () => {
    expect(denyToolsArgs(["mcp__*__notion-update-page", "mcp__*__notion-create-pages"])).toBe(
      "--disallowedTools 'mcp__*__notion-update-page' 'mcp__*__notion-create-pages'",
    );
  });

  it("refuses a rule that could break out of its quotes", () => {
    expect(() => denyToolsArgs(["x'; rm -rf ~; '"])).toThrow();
  });

  it("adds the rules to the command an agent starts with, and leaves other commands alone", () => {
    const claude: DelegationPreset = { id: "p", name: "Claude", agent: "claude", args: "--model opus", instructions: "" };
    expect(withDeniedTools(startCommand(claude, "s1"), ["mcp__*__notion-update-page"])).toBe(
      "claude --model opus --session-id s1 --disallowedTools 'mcp__*__notion-update-page'",
    );
    expect(withDeniedTools("claude", [])).toBe("claude");
  });
});
