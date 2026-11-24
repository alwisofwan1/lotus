import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentNodeActions } from "../useAgentNodeActions";

const BASE = "/repo";

function setup(cwd = BASE) {
  return renderHook(({ c }: { c: string }) => useAgentNodeActions({ cwd: c }), {
    initialProps: { c: cwd },
  });
}

function setupWithInitial(initialWorktree: { branch: string; path: string } | null) {
  return renderHook(() => useAgentNodeActions({ cwd: BASE, initialWorktree }));
}

describe("useAgentNodeActions", () => {
  it("starts with no panel, no worktree, and runs in the base cwd", () => {
    const { result } = setup();
    expect(result.current.activePanel).toBeNull();
    expect(result.current.worktree).toBeNull();
    expect(result.current.runCwd).toBe(BASE);
  });

  it("toggles the worktree panel open then closed", () => {
    const { result } = setup();
    act(() => result.current.toggleWT());
    expect(result.current.activePanel).toBe("wt");
    act(() => result.current.toggleWT());
    expect(result.current.activePanel).toBeNull();
  });

  it("switches directly between panels without an intermediate close", () => {
    const { result } = setup();
    act(() => result.current.toggleDiff());
    expect(result.current.activePanel).toBe("diff");
    act(() => result.current.toggleWT());
    expect(result.current.activePanel).toBe("wt");
  });

  it("assigning a worktree repoints runCwd to the worktree path and closes the panel", () => {
    const { result } = setup();
    act(() => result.current.toggleWT());
    act(() => result.current.assignWorktree("feature/x", "/repo/.wt/feature-x"));
    expect(result.current.worktree).toEqual({ branch: "feature/x", path: "/repo/.wt/feature-x" });
    expect(result.current.runCwd).toBe("/repo/.wt/feature-x");
    expect(result.current.activePanel).toBeNull();
  });

  it("unassigning a worktree restores the base cwd", () => {
    const { result } = setup();
    act(() => result.current.assignWorktree("feature/x", "/repo/.wt/feature-x"));
    act(() => result.current.unassignWorktree());
    expect(result.current.worktree).toBeNull();
    expect(result.current.runCwd).toBe(BASE);
  });

  it("closePanel dismisses whichever panel is open", () => {
    const { result } = setup();
    act(() => result.current.toggleDiff());
    act(() => result.current.closePanel());
    expect(result.current.activePanel).toBeNull();
  });

  describe("initialWorktree", () => {
    it("restores a persisted worktree on mount — runCwd points to the worktree path", () => {
      const { result } = setupWithInitial({ branch: "feat/restore", path: "/repo-wt/feat-restore" });
      expect(result.current.worktree).toEqual({ branch: "feat/restore", path: "/repo-wt/feat-restore" });
      expect(result.current.runCwd).toBe("/repo-wt/feat-restore");
    });

    it("starts with no worktree when initialWorktree is null", () => {
      const { result } = setupWithInitial(null);
      expect(result.current.worktree).toBeNull();
      expect(result.current.runCwd).toBe(BASE);
    });

    it("initial worktree can be overridden by assigning a new one", () => {
      const { result } = setupWithInitial({ branch: "feat/old", path: "/repo-wt/old" });
      act(() => result.current.assignWorktree("feat/new", "/repo-wt/new"));
      expect(result.current.worktree).toEqual({ branch: "feat/new", path: "/repo-wt/new" });
      expect(result.current.runCwd).toBe("/repo-wt/new");
    });
  });
});
