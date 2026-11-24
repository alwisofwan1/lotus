import { describe, it, expect } from "vitest";
import { filterSlashItems, SLASH_ITEMS } from "../note-slash-command";

describe("filterSlashItems", () => {
  it("returns every command for an empty query", () => {
    expect(filterSlashItems("")).toEqual(SLASH_ITEMS);
    expect(filterSlashItems("   ")).toEqual(SLASH_ITEMS);
  });

  it("matches on title, case-insensitively", () => {
    const result = filterSlashItems("HEAD");
    expect(result.map((i) => i.id)).toEqual(["heading-1", "heading-2"]);
  });

  it("matches on keywords the title does not contain", () => {
    expect(filterSlashItems("todo").map((i) => i.id)).toEqual(["task-list"]);
    expect(filterSlashItems("checkbox").map((i) => i.id)).toEqual(["task-list"]);
  });

  it("returns nothing when no command matches", () => {
    expect(filterSlashItems("zzz")).toEqual([]);
  });
});
