import { describe, expect, it } from "vitest";
import {
  notionSourceId,
  notionVocabulary,
  toTrackerTaskFromNotionRow,
  type NotionRow,
  type StatusSchema,
} from "@/modules/tasks/services/notion-source";

const statuses: StatusSchema = {
  options: [
    { id: "backlog", name: "Backlog", color: "default" },
    { id: "todo", name: "Todo", color: "gray" },
    { id: "progress", name: "In progress", color: "blue" },
    { id: "review", name: "In review", color: "purple" },
    { id: "released", name: "Released", color: "green" },
    { id: "wontdo", name: "Won’t do", color: "red" },
  ],
  groups: [
    { id: "g1", name: "To-do", optionIds: ["backlog", "todo"] },
    { id: "g2", name: "In progress", optionIds: ["progress", "review"] },
    { id: "g3", name: "Complete", optionIds: ["released", "wontdo"] },
  ],
};

describe("a Notion board's statuses as the tracker speaks them", () => {
  it("keeps Notion's own names, never renamed", () => {
    expect(notionVocabulary(statuses).labels).toMatchObject({ backlog: "Backlog", wontdo: "Won’t do" });
  });

  it("puts work in flight first and finished work last, keeping Notion's order inside a group", () => {
    expect(notionVocabulary(statuses).order).toEqual(["progress", "review", "backlog", "todo", "released", "wontdo"]);
  });

  it("reads To-do and In progress as open, Complete as closed", () => {
    const v = notionVocabulary(statuses);
    expect(v.open).toEqual(["progress", "review", "backlog", "todo"]);
    expect(v.tones).toMatchObject({ progress: "progress", backlog: "open", released: "done" });
  });

  it("recognises the groups by place when their names are unfamiliar", () => {
    const renamed: StatusSchema = {
      ...statuses,
      groups: statuses.groups.map((g, i) => ({ ...g, name: ["Belum", "Jalan", "Beres"][i] })),
    };
    expect(notionVocabulary(renamed).open).toEqual(["progress", "review", "backlog", "todo"]);
  });

  it("is empty when the board has no status field", () => {
    expect(notionVocabulary(null)).toEqual({ order: [], labels: {}, tones: {}, open: [] });
  });
});

describe("a Notion page as a tracker row", () => {
  const row: NotionRow = {
    pageId: "p1",
    url: "https://www.notion.so/p1",
    key: "TKT-1008",
    title: "Stripe webhook",
    status: "progress",
    assignees: ["Alwi"], assigneeIds: [],
    labels: [],
    parents: [],
    createdTime: "2026-09-01T10:00:00.000Z",
    lastEditedTime: "2026-09-02T10:00:00.000Z",
  };

  it("keeps the key the ticket carries, and its status option's id", () => {
    const task = toTrackerTaskFromNotionRow(row, "notion-abc");
    expect(task).toMatchObject({ id: "p1", projectId: "notion-abc", key: "TKT-1008", number: 1008, status: "progress", priority: "none" });
    expect(task.updatedAt).toBe(Date.parse(row.lastEditedTime));
  });

  it("names an untitled page rather than drawing an empty row", () => {
    expect(toTrackerTaskFromNotionRow({ ...row, title: "", key: null }, "n").title).toBe("Untitled");
  });
});

describe("a Notion source's id", () => {
  it("comes from the database, so the same database cannot be added twice", () => {
    const id = "248104cd-477e-80af-bc30-000bea2dd2a5";
    expect(notionSourceId(id)).toBe(notionSourceId(id));
    expect(notionSourceId(id)).toMatch(/^notion-[0-9a-f]{32}$/);
  });
});
