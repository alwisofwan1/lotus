import { describe, expect, it } from "vitest";

import { chatMentionText, filterChats, pathQuery, tildePath } from "../mention";

const chat = (id: string, title: string | null, updatedAt: number, archived = false) => ({ id, title, updatedAt, archived });

describe("filterChats", () => {
  const chats = [chat("a", "Fix login bug", 1), chat("b", "login page copy", 3), chat("c", "Deploy notes", 2), chat("d", null, 9), chat("e", "login old", 8, true)];

  it("ranks title starts first, then newest; skips untitled, archived and the current chat", () => {
    expect(filterChats(chats, "login", null, 5).map((c) => c.id)).toEqual(["b", "a"]);
    expect(filterChats(chats, "", "b", 5).map((c) => c.id)).toEqual(["c", "a"]);
    expect(filterChats(chats, "", null, 1).map((c) => c.id)).toEqual(["b"]);
    expect(filterChats(chats, "zzz", null, 5)).toEqual([]);
  });
});

describe("chatMentionText", () => {
  it("keeps the title on one line, without double quotes, and short", () => {
    expect(chatMentionText('say "hi"\nnow', "x1")).toBe(`chat "say 'hi' now" (chatId x1)`);
    expect(chatMentionText("a".repeat(80), "x2")).toBe(`chat "${"a".repeat(59)}…" (chatId x2)`);
  });
});

describe("pathQuery", () => {
  const at = (q: string) => pathQuery(q, "/w/lotus/app", "/Users/me");
  it.each([
    ["/", { dir: "/", name: "", typedDir: "/" }],
    ["/Users/me/Do", { dir: "/Users/me/", name: "Do", typedDir: "/Users/me/" }],
    ["~/work/ex", { dir: "/Users/me/work/", name: "ex", typedDir: "~/work/" }],
    ["../", { dir: "/w/lotus/", name: "", typedDir: "../" }],
    ["../../bb/pa", { dir: "/w/bb/", name: "pa", typedDir: "../../bb/" }],
    ["./src/", { dir: "/w/lotus/app/src/", name: "", typedDir: "./src/" }],
    ["../../../../..", { dir: "/", name: "..", typedDir: "../../../../" }],
  ])("%s", (query, expected) => expect(at(query)).toEqual(expected));

  it("is null for a plain query, and for ~ or ./ with nothing to resolve them against", () => {
    expect(at("chat")).toBeNull();
    expect(at("~")).toBeNull();
    expect(pathQuery("~/x", "/w", null)).toBeNull();
    expect(pathQuery("../x", null, "/Users/me")).toBeNull();
  });
});

describe("tildePath", () => {
  it("shortens home only on a segment boundary", () => {
    expect(tildePath("/Users/me/a.txt", "/Users/me")).toBe("~/a.txt");
    expect(tildePath("/Users/meow/a.txt", "/Users/me")).toBe("/Users/meow/a.txt");
    expect(tildePath("/x", null)).toBe("/x");
  });
});
