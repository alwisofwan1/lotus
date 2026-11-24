import { describe, it, expect, vi } from "vitest";
import { validateWorktreeAssignments } from "../worktree-validation";

type Stub = { id: string; cwd: string; assignedWorktree: string | null; assignedWorktreePath: string | null };

const alive = [
  { path: "/repo", branch: "main", isMain: true },
  { path: "/repo-wt/feat", branch: "feature/x", isMain: false },
];

describe("validateWorktreeAssignments", () => {
  it("returns empty map when no node has an assignment", async () => {
    const listFn = vi.fn().mockResolvedValue(alive);
    const nodes: Stub[] = [{ id: "t1", cwd: "/repo", assignedWorktree: null, assignedWorktreePath: null }];
    const result = await validateWorktreeAssignments(nodes, listFn);
    expect(result.size).toBe(0);
  });

  it("marks a node stale when its branch no longer exists", async () => {
    const listFn = vi.fn().mockResolvedValue(alive);
    const nodes: Stub[] = [{ id: "t1", cwd: "/repo", assignedWorktree: "deleted/branch", assignedWorktreePath: "/repo-wt/deleted" }];
    const result = await validateWorktreeAssignments(nodes, listFn);
    expect(result.get("t1")).toEqual({ branch: null, path: null });
  });

  it("does not mark a node stale when its branch is still alive", async () => {
    const listFn = vi.fn().mockResolvedValue(alive);
    const nodes: Stub[] = [{ id: "t1", cwd: "/repo", assignedWorktree: "feature/x", assignedWorktreePath: "/repo-wt/feat" }];
    const result = await validateWorktreeAssignments(nodes, listFn);
    expect(result.has("t1")).toBe(false);
  });

  it("calls listFn once per unique cwd", async () => {
    const listFn = vi.fn().mockResolvedValue(alive);
    const nodes: Stub[] = [
      { id: "t1", cwd: "/repo", assignedWorktree: "feature/x", assignedWorktreePath: "/repo-wt/feat" },
      { id: "t2", cwd: "/repo", assignedWorktree: "deleted/branch", assignedWorktreePath: "/repo-wt/deleted" },
    ];
    await validateWorktreeAssignments(nodes, listFn);
    expect(listFn).toHaveBeenCalledTimes(1);
  });

  it("handles listFn errors gracefully — skips the node rather than throwing", async () => {
    const listFn = vi.fn().mockRejectedValue(new Error("git not found"));
    const nodes: Stub[] = [{ id: "t1", cwd: "/bad-repo", assignedWorktree: "feature/x", assignedWorktreePath: "/bad-repo-wt/feat" }];
    const result = await validateWorktreeAssignments(nodes, listFn);
    expect(result.size).toBe(0);
  });

  it("handles multiple nodes across different repos", async () => {
    const listFn = vi.fn()
      .mockResolvedValueOnce(alive)
      .mockResolvedValueOnce([{ path: "/other", branch: "main", isMain: true }]);
    const nodes: Stub[] = [
      { id: "t1", cwd: "/repo", assignedWorktree: "deleted/branch", assignedWorktreePath: "/repo-wt/deleted" },
      { id: "t2", cwd: "/other", assignedWorktree: "main", assignedWorktreePath: "/other" },
    ];
    const result = await validateWorktreeAssignments(nodes, listFn);
    expect(result.has("t1")).toBe(true);
    expect(result.has("t2")).toBe(false);
  });
});
