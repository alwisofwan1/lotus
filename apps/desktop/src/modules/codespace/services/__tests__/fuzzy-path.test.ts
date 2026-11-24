import { describe, expect, it } from "vitest";
import { rankPaths } from "@/modules/codespace/services/fuzzy-path";

const root = "/repo";
const abs = (paths: string[]) => paths.map((path) => `${root}/${path}`);
const top = (query: string, paths: string[], limit = 10) =>
  rankPaths(query, abs(paths), { rootDir: root, limit }).map((hit) => hit.relativePath);

describe("rankPaths", () => {
  it("puts the file whose name spells the query at word starts first", () => {
    expect(top("wbc", [
      "src/modules/codespace/components/workbench/WorkbenchBrowserTab.tsx",
      "src/web/cache.ts",
      "src/modules/codespace/components/WorkbenchCell.tsx",
    ])[0]).toBe("src/modules/codespace/components/WorkbenchCell.tsx");
  });

  it("ranks a match in the file name above one in a folder name", () => {
    expect(top("app", ["src/app/index.ts", "src/App.tsx"])).toEqual(["src/App.tsx", "src/app/index.ts"]);
  });

  it("an exact folder prefix beats the same folders deeper down", () => {
    expect(top("src/components/", ["lib/src/components/x.ts", "src/components/App.tsx"])[0]).toBe("src/components/App.tsx");
  });

  it("matches a query with slashes segment by segment", () => {
    expect(top("comp/app", ["src/components/App.tsx", "src/compat/misc.ts", "docs/app.md"])).toEqual(["src/components/App.tsx"]);
  });

  it("breaks ties by the shorter path, then A–Z", () => {
    expect(top("index", ["b/deep/index.ts", "b/index.ts", "a/index.ts"])).toEqual(["a/index.ts", "b/index.ts", "b/deep/index.ts"]);
  });

  it("is case-sensitive only when the query has a capital", () => {
    expect(top("readme", ["README.md", "docs/readme.txt"])).toHaveLength(2);
    expect(top("README", ["README.md", "docs/readme.txt"])).toEqual(["README.md"]);
  });

  it("leaves out paths that do not contain the letters in order, and returns nothing for an empty query", () => {
    expect(top("xyz", ["src/a.ts"])).toEqual([]);
    expect(top("", ["src/a.ts"])).toEqual([]);
  });

  it("returns at most `limit` hits and where the letters matched in the name", () => {
    const hits = rankPaths("cell", abs(["a/Cell.tsx", "c/cells.ts", "d/xcell.ts"]), { rootDir: root, limit: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ name: "Cell.tsx", folder: "a", nameMatches: [0, 1, 2, 3] });
  });

  it("ignores a query longer than 256 characters past that point", () => {
    expect(() => rankPaths("a".repeat(5000), abs(["a.ts"]), { rootDir: root, limit: 5 })).not.toThrow();
  });
});

describe("rankPaths while typing (LOT2-211)", () => {
  const paths = abs([
    "src/app.ts",
    "lib/src/app.ts",
    "src/components/AppShell.tsx",
    "docs/apple.md",
    "tests/api/apps.test.ts",
    "README.md",
  ]);
  // A copy per call: a fresh array is a fresh index, so nothing carries over from typing.
  const fresh = (query: string) => rankPaths(query, [...paths], { rootDir: root, limit: 10 }).map((hit) => hit.relativePath);
  const typed = (query: string) => rankPaths(query, paths, { rootDir: root, limit: 10 }).map((hit) => hit.relativePath);

  it("gives the same hits letter by letter as a search from scratch", () => {
    for (const query of ["a", "ap", "app", "apps", "appst"]) expect(typed(query)).toEqual(fresh(query));
  });

  it("finds a folder match that the shorter query's tiers left out (src/ → src/app)", () => {
    typed("src/");
    expect(typed("src/app")).toEqual(fresh("src/app"));
    expect(typed("src/app")).toContain("lib/src/app.ts");
  });

  it("widens again after a deleted letter, and after a capital makes it case-sensitive", () => {
    typed("apple");
    expect(typed("app")).toEqual(fresh("app"));
    typed("a");
    expect(typed("aS")).toEqual(fresh("aS"));
    expect(typed("as")).toEqual(fresh("as"));
  });
});
