import { describe, expect, it } from "vitest";
import { rankPaths } from "@/modules/codespace/services/fuzzy-path";
import {
  buildTree,
  gitStatusLabel,
  searchTree,
  toRelative,
  type TreeNode,
} from "../file-tree-nodes";

const root = "/repo";
const entries = [
  { path: "/repo/src/zeta.ts", kind: "file" as const },
  { path: "/repo/src", kind: "directory" as const },
  { path: "/repo/README.md", kind: "file" as const },
  { path: "/repo/src/Alpha.ts", kind: "file" as const },
  { path: "/repo/src/lib/util.ts", kind: "file" as const },
  { path: "/repo/docs", kind: "directory" as const },
  { path: "/repo/src/zeta.ts", kind: "file" as const },
];

function names(nodes: TreeNode[]): unknown[] {
  return nodes.map((node) => (node.kind === "directory" ? { [node.name]: names(node.children) } : node.name));
}

describe("file tree helpers", () => {
  it("builds folders first, each level sorted without case, duplicates dropped", () => {
    expect(names(buildTree(root, entries))).toEqual([
      { docs: [] },
      { src: [{ lib: ["util.ts"] }, "Alpha.ts", "zeta.ts"] },
      "README.md",
    ]);
  });

  it("creates the folders a deep file needs even when they are not listed", () => {
    const tree = buildTree(root, [{ path: "/repo/a/b/c.ts", kind: "file" }]);
    expect(names(tree)).toEqual([{ a: [{ b: ["c.ts"] }] }]);
    const a = tree[0];
    expect(a.kind === "directory" && a.children[0]).toMatchObject({ relativePath: "a/b", absolutePath: "/repo/a/b" });
  });

  it("searches the whole index with the Go to file ranker, keeping only the parents of each hit", () => {
    const files = ["/repo/src/lib/util.ts", "/repo/src/components/FileTree.tsx", "/repo/README.md", "/repo/docs/guide.md"];
    expect(names(searchTree(root, "fltr", files, 50))).toEqual([{ src: [{ components: ["FileTree.tsx"] }] }]);
    expect(searchTree(root, "nothing-matches", files, 50)).toEqual([]);
  });

  it("shows the same files the palette ranks first, up to the limit", () => {
    const files = Array.from({ length: 30 }, (_, i) => `/repo/pkg${i % 3}/file${i}.ts`);
    const tree = searchTree(root, "file1", files, 5);
    const shown = tree.flatMap((node) => (node.kind === "directory" ? node.children.map((child) => child.absolutePath) : [node.absolutePath]));
    expect(shown.sort()).toEqual(rankPaths("file1", files, { rootDir: root, limit: 5 }).map((hit) => hit.path).sort());
  });

  it("reads paths relative to the root", () => {
    expect(toRelative("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(toRelative("/repo", "/elsewhere/a.ts")).toBe("/elsewhere/a.ts");
  });

  it("labels git states", () => {
    expect(gitStatusLabel({ path: "", relativePath: "", staged: null, unstaged: "untracked" })).toBe("?");
    expect(gitStatusLabel({ path: "", relativePath: "", staged: "added", unstaged: null })).toBe("A");
    expect(gitStatusLabel({ path: "", relativePath: "", staged: null, unstaged: "modified" })).toBe("M");
  });
});

describe("buildTree ignored entries", () => {
  it("carries the ignored mark onto folders and files, even when a deeper entry came first", () => {
    const tree = buildTree("/r", [
      { path: "/r/node_modules/pkg", kind: "directory" },
      { path: "/r/node_modules", kind: "directory", ignored: true },
      { path: "/r/debug.log", kind: "file", ignored: true },
      { path: "/r/src", kind: "directory" },
    ]);
    const byName = Object.fromEntries(tree.map((node) => [node.name, node.ignored ?? false]));
    expect(byName).toEqual({ node_modules: true, src: false, "debug.log": true });
  });
});

describe("buildTree path spelling", () => {
  function folder(nodes: TreeNode[], name: string) {
    const node = nodes.find((candidate) => candidate.name === name);
    if (node?.kind !== "directory") throw new Error(`${name} is not a folder`);
    return node;
  }

  it("spells a Windows folder with the root's backslash, as Rust and Go-to-file do", () => {
    const tree = buildTree("C:\\proj", [{ path: "C:\\proj\\src\\lib\\a.ts", kind: "file" }]);
    const lib = folder(folder(tree, "src").children, "lib");
    expect(lib).toMatchObject({ relativePath: "src/lib", absolutePath: "C:\\proj\\src\\lib" });
    expect(lib.children[0]).toMatchObject({ relativePath: "src/lib/a.ts", absolutePath: "C:\\proj\\src\\lib\\a.ts" });
  });

  it("keeps a WSL share forward-slashed and never doubles the root's trailing separator", () => {
    const tree = buildTree("//wsl.localhost/Ubuntu/home/dev/", [
      { path: "//wsl.localhost/Ubuntu/home/dev/src/a.ts", kind: "file" },
    ]);
    expect(folder(tree, "src").absolutePath).toBe("//wsl.localhost/Ubuntu/home/dev/src");
  });
});
