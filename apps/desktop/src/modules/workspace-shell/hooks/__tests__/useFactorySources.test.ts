import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFactorySources } from "../useFactorySources";
import type { SharedTrackerBoard } from "../TrackerBoardProvider";
import type { AutomationClient } from "@/modules/automation/services/automation-api";

const subfolders = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("@/lib/tauri/graph-run", async (original) => ({
  ...(await original<typeof import("@/lib/tauri/graph-run")>()),
  factoryGitSubfolders: vi.fn(async () => subfolders.list),
}));

/** Every Factory host reads the same sources off the one tracker board (Code's panel and the Dock). */

function shared(over: Partial<SharedTrackerBoard> = {}): SharedTrackerBoard {
  return {
    board: { tasks: [{ id: "i1", projectId: "gh-1", number: 7, title: "Fix it", status: "open" }], openTask: vi.fn(async () => null) },
    githubSources: [{ id: "gh-1", repo: "o/r", account: "me", name: "o/r" }],
    notionSources: [],
    workspaceFolders: () => [
      { id: "w1", cwd: "/code/r", remote: false },
      { id: "w2", cwd: "/remote/r", remote: true },
    ],
    ...over,
  } as unknown as SharedTrackerBoard;
}

describe("useFactorySources", () => {
  it("offers the board's GitHub repos to New run and Settings, with that repo's open issues", () => {
    const { result } = renderHook(() => useFactorySources(shared(), { findCheckout: vi.fn() } as unknown as AutomationClient));
    expect(result.current.newRun.repos.map((r) => r.repo)).toEqual(["o/r"]);
    expect(result.current.agents.repos).toEqual([{ id: "gh-1", repo: "o/r" }]);
    expect(result.current.newRun.issues("gh-1")).toEqual([{ number: 7, title: "Fix it" }]);
  });

  it("treats a folder with git sub-repos as a meta-repo even when the folder is itself a connected repo", async () => {
    const own = { id: "w1", cwd: "/code/r" };
    const findCheckout = vi.fn(async () => own);
    const { result } = renderHook(() => useFactorySources(shared(), { findCheckout } as unknown as AutomationClient));
    subfolders.list = ["api", "web"];
    const meta = await result.current.newRun.inspectWorkspace!("/code/r");
    expect(meta).toEqual({ repo: { id: "gh-1", repo: "o/r", account: "me", name: "o/r" }, subRepos: ["api", "web"], meta: true });
    // No sub-repos: the connected repo is the whole workspace, as before.
    subfolders.list = [];
    expect(await result.current.newRun.inspectWorkspace!("/code/r")).toEqual({
      repo: { id: "gh-1", repo: "o/r", account: "me", name: "o/r" },
      subRepos: [],
    });
  });

  it("finds a checkout among local workspaces only", async () => {
    const findCheckout = vi.fn(async () => ({ id: "w1", cwd: "/code/r" }));
    const { result } = renderHook(() => useFactorySources(shared(), { findCheckout } as unknown as AutomationClient));
    expect(await result.current.agents.findCheckout("o/r")).toBe("/code/r");
    expect(findCheckout).toHaveBeenCalledWith("o/r", [{ id: "w1", cwd: "/code/r" }], null);
  });
});
