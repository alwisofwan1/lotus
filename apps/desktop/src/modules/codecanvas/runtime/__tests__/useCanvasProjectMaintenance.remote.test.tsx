import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const listWorktreesFor = vi.fn();
const getActiveProjectLocation = vi.fn();

vi.mock("../../services/remote-git", () => ({
  listWorktreesFor: (...args: unknown[]) => listWorktreesFor(...args),
}));
vi.mock("../../services/canvas-active-project", () => ({
  getActiveProjectLocation: () => getActiveProjectLocation(),
}));

const { useCanvasProjectMaintenance } = await import("../useCanvasProjectMaintenance");

const SSH = { kind: "ssh" as const, host: "devbox-vps", user: "root" };

function nodeWithWorktree(cwd: string) {
  return {
    id: "agent-1",
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      cwd,
      assignedWorktree: "lotus/tim/rowan",
      assignedWorktreePath: `${cwd}-rowan`,
    },
  } as never;
}

describe("the stale-worktree sweep, for a project that lives elsewhere", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listWorktreesFor.mockResolvedValue([]);
  });

  /**
   * Asking this laptop about a worktree on a VPS is how a live assignment gets cleared as stale —
   * the agent keeps running in a directory the board no longer believes in.
   */
  it("asks the project's machine, not this one", async () => {
    getActiveProjectLocation.mockReturnValue(SSH);
    renderHook(() =>
      useCanvasProjectMaintenance({
        nodes: [nodeWithWorktree("/srv/api")],
        rootDir: "/srv/api",
        activeProjectId: "p1",
        patchNodeData: vi.fn(),
      }),
    );

    await waitFor(() => expect(listWorktreesFor).toHaveBeenCalled());
    expect(listWorktreesFor).toHaveBeenCalledWith(SSH, "/srv/api");
  });

  it("still asks this machine for a local project", async () => {
    getActiveProjectLocation.mockReturnValue(null);
    renderHook(() =>
      useCanvasProjectMaintenance({
        nodes: [nodeWithWorktree("/repo")],
        rootDir: "/repo",
        activeProjectId: "p2",
        patchNodeData: vi.fn(),
      }),
    );

    await waitFor(() => expect(listWorktreesFor).toHaveBeenCalled());
    expect(listWorktreesFor).toHaveBeenCalledWith(null, "/repo");
  });

  it("clears an assignment whose branch is gone from that machine", async () => {
    getActiveProjectLocation.mockReturnValue(SSH);
    listWorktreesFor.mockResolvedValue([{ path: "/srv/api", branch: "main", isMain: true }]);
    const patchNodeData = vi.fn();

    renderHook(() =>
      useCanvasProjectMaintenance({
        nodes: [nodeWithWorktree("/srv/api")],
        rootDir: "/srv/api",
        activeProjectId: "p3",
        patchNodeData,
      }),
    );

    await waitFor(() =>
      expect(patchNodeData).toHaveBeenCalledWith("agent-1", { branch: null, path: null }),
    );
  });
});
