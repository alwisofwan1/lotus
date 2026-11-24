import { describe, expect, it } from "vitest";

import { absPath, changedInFolder, mentionedPaths, filterFiles, parseFileRef, resolveFile, treeIndex, withFolders } from "../files";

describe("parseFileRef", () => {
  it("reads paths with and without a line", () => {
    expect(parseFileRef("src/auth/LoginForm.tsx:21")).toEqual({ path: "src/auth/LoginForm.tsx", line: 21 });
    expect(parseFileRef("LoginForm.tsx")).toEqual({ path: "LoginForm.tsx", line: null });
    expect(parseFileRef("/repo/a.ts:3:7")).toEqual({ path: "/repo/a.ts", line: 3 });
    expect(parseFileRef("README.md#L12")).toEqual({ path: "README.md", line: 12 });
    expect(parseFileRef("docs/mockup.pdf#page=4")).toEqual({ path: "docs/mockup.pdf", line: 4 });
    expect(parseFileRef("src/styles")).toEqual({ path: "src/styles", line: null });
  });

  it("leaves commands and versions alone", () => {
    for (const text of ["npm test", "v1.2", "1.25", "foo()", "git diff --stat", "useState"]) expect(parseFileRef(text)).toBeNull();
  });
});

describe("resolveFile", () => {
  const files = new Set(["src/auth/LoginForm.tsx", "src/a/index.ts", "src/b/index.ts", "README.md"]);

  it("finds exact, absolute and unique trailing matches", () => {
    expect(resolveFile(files, "README.md", "/repo")).toBe("README.md");
    expect(resolveFile(files, "/repo/src/auth/LoginForm.tsx", "/repo/")).toBe("src/auth/LoginForm.tsx");
    expect(resolveFile(files, "LoginForm.tsx", "/repo")).toBe("src/auth/LoginForm.tsx");
    expect(resolveFile(files, "./auth/LoginForm.tsx", "/repo")).toBe("src/auth/LoginForm.tsx");
  });

  it("keeps an absolute file outside the folder as is", () => {
    expect(resolveFile(files, "/Users/me/vault/notes/retro.md", "/repo")).toBe("/Users/me/vault/notes/retro.md");
    expect(absPath("/repo/", "/Users/me/a.pdf")).toBe("/Users/me/a.pdf");
    expect(absPath("/repo/", "src/a.ts")).toBe("/repo/src/a.ts");
  });

  it("refuses ambiguous, outside folders and missing paths", () => {
    expect(resolveFile(files, "index.ts", "/repo")).toBeNull();
    expect(resolveFile(files, "/elsewhere/src", "/repo")).toBeNull();
    expect(resolveFile(files, "nope.ts", "/repo")).toBeNull();
  });
});

describe("treeIndex", () => {
  it("shows an empty folder it is given", () => {
    const tree = treeIndex(["src/a.ts"], ["src/new/deep", "docs"]);
    expect(tree.get("")?.map((e) => e.path)).toEqual(["docs", "src"]);
    expect(tree.get("src")?.map((e) => e.path)).toEqual(["src/new", "src/a.ts"]);
    expect(tree.get("src/new/deep")).toEqual([]);
  });

  it("lists folders first, then files, per folder", () => {
    const tree = treeIndex(["b.md", "src/z.ts", "src/lib/x.ts", "a.md"]);
    expect(tree.get("")?.map((e) => e.path)).toEqual(["src", "a.md", "b.md"]);
    expect(tree.get("src")?.map((e) => e.path)).toEqual(["src/lib", "src/z.ts"]);
    expect(tree.get("src/lib")?.map((e) => e.name)).toEqual(["x.ts"]);
  });
});

describe("filterFiles", () => {
  it("puts name matches before path matches", () => {
    expect(filterFiles(["login/a.ts", "src/LoginForm.tsx", "b.ts"], "login")).toEqual(["src/LoginForm.tsx", "login/a.ts"]);
    expect(filterFiles(["a"], "  ")).toEqual([]);
  });

  it("puts names that start with the query first, and names folders by their last segment", () => {
    expect(filterFiles(["index.html", "docs/", "README.md", "src/d.ts"], "d")).toEqual(["docs/", "src/d.ts", "index.html", "README.md"]);
  });

  it("matches a name's letters in order last, from two letters on", () => {
    expect(filterFiles(["ui/ChatComposer.tsx", "chcmp.md", "ui/ChatMention.tsx"], "chcmp")).toEqual(["chcmp.md", "ui/ChatComposer.tsx"]);
    expect(filterFiles(["abc.ts"], "x")).toEqual([]);
  });
});

describe("withFolders", () => {
  it("adds each folder once, before the files", () => {
    expect(withFolders(["a.ts", "src/x/b.ts", "src/c.ts"])).toEqual(["src/", "src/x/", "a.ts", "src/x/b.ts", "src/c.ts"]);
  });
});

describe("changedInFolder", () => {
  it("keeps the folder's files, relative to it", () => {
    expect([...changedInFolder(["app/src/a.ts", "other/b.ts"], "app/")]).toEqual(["src/a.ts"]);
  });
});

describe("mentionedPaths", () => {
  it("reads code spans and link targets once each, never code blocks", () => {
    const text = "See `src/a.ts:3`, [plan](plans/PLAN.md), [doc](file:///Users/me/My%20Notes/x.md), `src/a.ts`, [web](https://x.dev/a.md) and `npm test`.\n\n```sh\nopen hidden.html\n```";
    expect(mentionedPaths(text)).toEqual(["src/a.ts", "plans/PLAN.md"]);
  });
});
