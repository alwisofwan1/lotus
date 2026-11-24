import { describe, it, expect, vi } from "vitest";

import { isolateAgentNode, type IsolationDeps } from "../agent-isolation";
import type { WorktreeEntry } from "@/lib/tauri/canvas-git";

function makeDeps(overrides: Partial<IsolationDeps> = {}): IsolationDeps {
  return {
    resolveHeadBranch: vi.fn().mockResolvedValue("main"),
    listWorktrees: vi.fn().mockResolvedValue([] as WorktreeEntry[]),
    createWorktree: vi
      .fn()
      .mockResolvedValue({ path: "", branch: null, isMain: false } as WorktreeEntry),
    ...overrides,
  };
}

describe("isolateAgentNode", () => {
  it("creates a worktree on a derived branch/path beside the repo and returns the isolation", async () => {
    const deps = makeDeps();
    const result = await isolateAgentNode(
      {
        repoPath: "/Users/me/checkout",
        teamLabel: "Checkout Revamp",
        agentLabel: "Frontend Specialist",
      },
      deps,
    );

    expect(result).toEqual({
      branch: "lotus/checkout-revamp/frontend-specialist",
      path: "/Users/me/.lotus-worktrees/checkout-revamp/frontend-specialist",
      baseBranch: "main",
    });
    expect(deps.createWorktree).toHaveBeenCalledWith(
      "/Users/me/checkout",
      "lotus/checkout-revamp/frontend-specialist",
      "/Users/me/.lotus-worktrees/checkout-revamp/frontend-specialist",
    );
  });

  it("disambiguates the agent slug when a worktree for the same team/agent exists", async () => {
    const deps = makeDeps({
      listWorktrees: vi.fn().mockResolvedValue([
        { path: "/x", branch: "lotus/checkout-revamp/frontend", isMain: false },
        { path: "/y", branch: "main", isMain: true },
      ] as WorktreeEntry[]),
    });
    const result = await isolateAgentNode(
      { repoPath: "/Users/me/checkout", teamLabel: "Checkout Revamp", agentLabel: "Frontend" },
      deps,
    );

    expect(result.branch).toBe("lotus/checkout-revamp/frontend-2");
    expect(result.path).toBe(
      "/Users/me/.lotus-worktrees/checkout-revamp/frontend-2",
    );
  });
});
