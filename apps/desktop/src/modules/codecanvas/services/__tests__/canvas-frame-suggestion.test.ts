import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { pickFrameSuggestion, suggestFrames, suggestionText } from "../canvas-frame-suggestion";

const n = (id: string, data: Record<string, unknown> = {}, type = "terminal"): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const branch = (id: string, b: string, extra: Record<string, unknown> = {}) => n(id, { assignedWorktree: b, ...extra });

describe("suggestFrames: spawned for the same task (decision 26)", () => {
  const task = (id: string, key: string, title?: string) => n(id, { spawnTaskKey: key, ...(title ? { spawnTaskTitle: title } : {}) });
  it("groups loose nodes an agent spawned for one task, named after the task title", () => {
    const out = suggestFrames([task("a", "t1", "Fix login"), task("b", "t1", "Fix login"), task("c", "t2", "Other"), n("z")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ context: "Fix login", memberIds: ["a", "b"], taskKey: "t1" });
  });
  it("falls back to the task key without a title", () => {
    expect(suggestFrames([task("a", "t1"), task("b", "t1")])[0].context).toBe("t1");
  });
  it("a task group wins over a shared branch for the same node", () => {
    const out = suggestFrames([branch("a", "feat/x", { spawnTaskKey: "t1" }), branch("b", "feat/x", { spawnTaskKey: "t1" })]);
    expect(out[0]).toMatchObject({ taskKey: "t1" });
  });
});

describe("suggestFrames", () => {
  it("suggests loose nodes sharing a branch", () => {
    const out = suggestFrames([branch("a", "feat/x"), branch("b", "feat/x"), branch("c", "feat/x"), n("z")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ context: "feat/x", memberIds: ["a", "b", "c"] });
  });

  it("falls back to the worktree folder name", () => {
    const mk = (id: string) => n(id, { assignedWorktreePath: "/w/repo-auth/" });
    expect(suggestFrames([mk("a"), mk("b")])[0].context).toBe("repo-auth");
  });

  it("needs at least two members", () => {
    expect(suggestFrames([branch("a", "feat/x"), branch("b", "feat/y")])).toEqual([]);
  });

  it("ignores nodes already in a Frame, Frames, shapes and ephemeral nodes", () => {
    const nodes = [
      branch("a", "feat/x", { frameId: "f1" }),
      branch("b", "feat/x"),
      { ...branch("c", "feat/x"), type: "shape" },
      { ...branch("d", "feat/x"), type: "frame" },
      { ...branch("e", "feat/x"), type: "skills" },
    ];
    expect(suggestFrames(nodes)).toEqual([]);
  });

  it("skips a dismissed set, but a new member re-qualifies", () => {
    const base = [branch("a", "feat/x"), branch("b", "feat/x")];
    const [first] = suggestFrames(base);
    expect(suggestFrames(base, new Set([first.key]))).toEqual([]);
    const grown = suggestFrames([...base, branch("c", "feat/x")], new Set([first.key]));
    expect(grown).toHaveLength(1);
    expect(grown[0].memberIds).toEqual(["a", "b", "c"]);
  });

  it("key does not depend on node order", () => {
    const a = suggestFrames([branch("a", "feat/x"), branch("b", "feat/x")])[0].key;
    const b = suggestFrames([branch("b", "feat/x"), branch("a", "feat/x")])[0].key;
    expect(a).toBe(b);
  });
});

describe("pickFrameSuggestion", () => {
  it("returns only the biggest group", () => {
    const nodes = [branch("a", "p"), branch("b", "p"), branch("c", "q"), branch("d", "q"), branch("e", "q")];
    expect(pickFrameSuggestion(nodes)?.context).toBe("q");
  });
  it("returns null when nothing qualifies", () => {
    expect(pickFrameSuggestion([n("a")])).toBeNull();
  });
});

describe("suggestionText", () => {
  it("reads in Indonesian", () => {
    const s = pickFrameSuggestion([branch("a", "feat/x"), branch("b", "feat/x")])!;
    expect(suggestionText(s)).toBe("2 node di feat/x → Jadikan Frame?");
  });
});
