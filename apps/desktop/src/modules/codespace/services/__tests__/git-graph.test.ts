import { describe, expect, it } from "vitest";
import type { GraphRef, GraphRefs } from "@/lib/tauri/git-graph";
import { MAX_LANES, laneColumns, layoutLanes } from "@/modules/codespace/services/git-graph-lanes";
import { splitMessage } from "@/modules/codespace/services/git-graph-message";
import { labelsByCommit, scopeRevs, searchRevs, syncMarks } from "@/modules/codespace/services/git-graph-scope";

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

describe("layoutLanes", () => {
  it("keeps a straight history in one lane", () => {
    const rows = layoutLanes([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((row) => row.col)).toEqual([0, 0, 0]);
    expect(rows[2]!.after).toEqual([]);
    expect(laneColumns(rows)).toBe(1);
  });

  it("forks at a merge and joins where the branch started", () => {
    // m merges f into main; both start at a.
    const rows = layoutLanes([c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")]);
    expect(rows[0]!.forks).toEqual([{ col: 1, hue: 1 }]);
    expect(rows[1]!.col).toBe(1);
    expect(rows[2]!.col).toBe(0);
    // Both lanes wait for a: the second bends into the first.
    expect(rows[3]!.col).toBe(0);
    expect(rows[3]!.merging).toEqual([{ col: 1, hue: 1 }]);
  });

  it("keeps a lane's hue when a lane to its left ends", () => {
    // Three tips: x and y end on a early, z runs on in its column with its own hue.
    const rows = layoutLanes([c("x", "a"), c("y", "a"), c("z", "q"), c("a"), c("q")]);
    const z = rows[2]!;
    expect(z.col).toBe(2);
    expect(rows[4]!.col).toBe(2);
    expect(rows[4]!.hue).toBe(z.hue);
    expect(new Set(rows.slice(0, 3).map((row) => row.hue)).size).toBe(3);
  });

  it("caps the drawn columns and reuses freed ones", () => {
    const tips = Array.from({ length: 9 }, (_, i) => c(`t${i}`, "root"));
    const rows = layoutLanes([...tips, c("root")]);
    expect(laneColumns(rows)).toBe(MAX_LANES + 1);
    // root takes the first lane that waited for it; the others bend in.
    expect(rows[9]!.merging).toHaveLength(8);
    const after = layoutLanes([...tips, c("root"), c("new")]);
    expect(after[10]!.col).toBe(0);
  });

  it("starts a commit whose child is not loaded as a new tip", () => {
    const rows = layoutLanes([c("b", "a")]);
    expect(rows[0]!.before).toEqual([]);
    expect(rows[0]!.after).toEqual([{ sha: "a", hue: 0 }]);
  });
});

const ref = (over: Partial<GraphRef> & Pick<GraphRef, "name" | "kind" | "target">): GraphRef => ({
  fullName: over.kind === "local" ? `refs/heads/${over.name}` : over.kind === "remote" ? `refs/remotes/${over.name}` : `refs/tags/${over.name}`,
  upstream: null,
  isHead: false,
  worktree: null,
  ...over,
});

const refs = (over: Partial<GraphRefs> = {}): GraphRefs => ({
  head: "h1",
  detached: false,
  shallow: false,
  defaultBranch: "main",
  outgoing: [],
  incoming: [],
  refs: [
    ref({ name: "feat", kind: "local", target: "h1", isHead: true, worktree: "/r", upstream: "origin/feat" }),
    ref({ name: "main", kind: "local", target: "m1", upstream: "origin/main" }),
    ref({ name: "agent/nia", kind: "local", target: "n1", worktree: "/r/.lotus/nia" }),
    ref({ name: "spike", kind: "local", target: "s1" }),
    ref({ name: "origin/feat", kind: "remote", target: "h0" }),
    ref({ name: "origin/main", kind: "remote", target: "m1" }),
    ref({ name: "origin/old", kind: "remote", target: "o1" }),
    ref({ name: "v1", kind: "tag", target: "m1" }),
  ],
  ...over,
});

describe("scope", () => {
  it("Smart draws HEAD's branch, main, worktree branches and their upstreams", () => {
    expect(scopeRevs(refs(), "smart")).toEqual([
      "HEAD",
      "refs/heads/feat",
      "refs/remotes/origin/feat",
      "refs/heads/main",
      "refs/remotes/origin/main",
      "refs/heads/agent/nia",
    ]);
  });

  it("All adds every local branch but not stray remotes", () => {
    const revs = scopeRevs(refs(), "all");
    expect(revs).toContain("refs/heads/spike");
    expect(revs).not.toContain("refs/remotes/origin/old");
  });

  it("walks nothing in a repository with no commit", () => {
    expect(scopeRevs(refs({ head: null }), "all")).toEqual([]);
    expect(searchRevs(refs({ head: null }))).toEqual([]);
  });

  it("search walks every ref", () => {
    expect(searchRevs(refs())).toHaveLength(9);
  });

  it("labels only drawn branches, HEAD's first, tags always", () => {
    const smart = labelsByCommit(refs(), "smart");
    expect(smart.get("m1")!.map((r) => r.name)).toEqual(["main", "origin/main", "v1"]);
    expect(smart.has("s1")).toBe(false);
    expect(smart.has("o1")).toBe(false);
    expect(labelsByCommit(refs(), "all").has("s1")).toBe(true);
  });

  it("marks commits not pushed and not pulled", () => {
    const marks = syncMarks(refs({ outgoing: ["a"], incoming: ["b"] }));
    expect(marks.get("a")).toBe("outgoing");
    expect(marks.get("b")).toBe("incoming");
  });
});

describe("splitMessage", () => {
  it("links hashes and #N, not plain words or numbers", () => {
    const parts = splitMessage("Fix #318, see 906595b. Not 1234567, not facade, not a/#2.");
    expect(parts.filter((p) => p.kind !== "text")).toEqual([
      { kind: "issue", text: "#318", number: 318 },
      { kind: "sha", text: "906595b" },
    ]);
    expect(parts.map((p) => p.text).join("")).toBe("Fix #318, see 906595b. Not 1234567, not facade, not a/#2.");
  });
});
