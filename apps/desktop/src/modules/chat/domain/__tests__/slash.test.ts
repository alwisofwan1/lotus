import { describe, expect, it } from "vitest";

import { claudeSlashItems, codexSlashItems, filterSlashItems, rememberRecent, slashMessage, withRecent, type SlashItem } from "../slash";

describe("claudeSlashItems", () => {
  it("keeps clear/compact as commands, drops TUI builtins, tags skill sources", () => {
    const items = claudeSlashItems(
      [
        { name: "clear", description: "Clear conversation history", argumentHint: "", builtin: true },
        { name: "config", description: "Open config", argumentHint: "", builtin: true },
        { name: "review", description: "Review a PR", argumentHint: "", builtin: true },
        { name: "lotus-probe", description: "Probe skill (project)", argumentHint: "<word>" },
        { name: "ponytail:impl", description: "Implement lazily (user)", argumentHint: "" },
        { name: "notes", description: "Notes (claude.ai sync)", argumentHint: "" },
        { name: "lotus-probe", description: "dup (project)", argumentHint: "" },
      ],
      ["review", "lotus-probe"],
    );
    expect(items).toEqual([
      { kind: "command", name: "clear", description: "Start fresh context in this thread", argumentHint: null, source: "built-in", path: null },
      { kind: "skill", name: "review", description: "Review a PR", argumentHint: null, source: "built-in", path: null },
      { kind: "skill", name: "lotus-probe", description: "Probe skill", argumentHint: "<word>", source: "project", path: null },
      { kind: "skill", name: "ponytail:impl", description: "Implement lazily", argumentHint: null, source: "plugin", path: null },
      { kind: "skill", name: "notes", description: "Notes", argumentHint: null, source: "claude.ai sync", path: null },
    ]);
  });
});

describe("codexSlashItems", () => {
  it("offers clear/compact, then enabled skills once, short description first, repo scope as 'project'", () => {
    const items = codexSlashItems([
      { name: "a", description: "long a", shortDescription: "short a", path: "/r/a/SKILL.md", scope: "repo", enabled: true },
      { name: "b", description: "b", path: "/u/b/SKILL.md", scope: "user", enabled: false },
      { name: "a", description: "again", path: "/u/a/SKILL.md", scope: "user", enabled: true },
    ]);
    expect(items.map((i) => `${i.kind}:${i.name}`).slice(0, 2)).toEqual(["command:clear", "command:compact"]);
    expect(items.slice(2)).toEqual([{ kind: "skill", name: "a", description: "short a", argumentHint: null, source: "project", path: "/r/a/SKILL.md" }]);
  });
});

describe("filterSlashItems", () => {
  const item = (kind: SlashItem["kind"], name: string, description = ""): SlashItem => ({ kind, name, description, argumentHint: null, source: null, path: null });
  const items = [
    item("skill", "lotus-browser"),
    item("skill", "tdd", "test first"),
    item("skill", "ponytail:lotus"),
    item("skill", "lotus"),
    item("command", "clear"),
    item("skill", "low-tide"),
  ];
  const names = (q: string) => filterSlashItems(items, q).map((m) => m.item.name);

  it("keeps all for an empty query, commands first", () => {
    expect(names("")).toEqual(["clear", "lotus-browser", "tdd", "ponytail:lotus", "lotus", "low-tide"]);
  });

  it("ranks exact, plugin leaf, prefix, substring, fuzzy, description", () => {
    expect(names("lotus")).toEqual(["lotus", "ponytail:lotus", "lotus-browser"]);
    expect(names("lo")).toEqual(["lotus-browser", "ponytail:lotus", "lotus", "low-tide"]);
    expect(names("first")).toEqual(["tdd"]);
    expect(names("lbr")).toEqual(["lotus-browser"]);
    expect(names("zzz")).toEqual([]);
  });

  it("reports the matched letters", () => {
    expect(filterSlashItems(items, "lbr")[0].hits).toEqual([0, 6, 7]);
    expect(filterSlashItems(items, "lotus").find((m) => m.item.name === "ponytail:lotus")?.hits).toEqual([9, 10, 11, 12, 13]);
  });
});

describe("slashMessage", () => {
  it("puts the skill first and the rest after one space", () => {
    expect(slashMessage("lotus-probe", "  banana ")).toBe("/lotus-probe banana");
    expect(slashMessage("clear", "")).toBe("/clear");
  });
});

describe("recent skills", () => {
  const item = (kind: SlashItem["kind"], name: string): SlashItem => ({ kind, name, description: "", argumentHint: null, source: null, path: null });
  const matches = filterSlashItems([item("command", "clear"), item("skill", "a"), item("skill", "b"), item("skill", "c"), item("skill", "d")], "");

  it("moves up to three recent skills that are present to the front, marked", () => {
    const out = withRecent(matches, ["d", "gone", "clear", "b", "a", "c"]);
    expect(out.map((m) => `${m.recent ? "*" : ""}${m.item.name}`)).toEqual(["*d", "*b", "*a", "clear", "c"]);
  });

  it("remembers newest first, without repeats, up to a cap", () => {
    expect(rememberRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(rememberRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });
});
