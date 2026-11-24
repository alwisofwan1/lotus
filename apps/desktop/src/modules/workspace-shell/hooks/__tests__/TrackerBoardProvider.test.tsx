import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

type BoardInput = { projects: { id: string; name: string }[]; tasksOpen?: boolean; activities: ReadonlyMap<string, unknown> };
const boardInputs: BoardInput[] = [];
vi.mock("@/modules/tasks/hooks/useTrackerBoard", () => ({
  useTrackerBoard: (input: BoardInput) => {
    boardInputs.push(input);
    return { tasks: [], projects: [], projectsById: new Map() };
  },
}));
vi.mock("@/modules/tasks/hooks/useVaultPath", () => ({
  useVaultPath: () => ({ path: "", sources: [], connect: vi.fn(), disconnect: vi.fn(), addNotionSource: vi.fn(), addGitHubSource: vi.fn(), removeSource: vi.fn() }),
}));
vi.mock("@/modules/codespace/services/workspace-metadata", () => ({
  loadPersistedCodeSpaceSnapshot: async () => ({
    workspaces: [
      { id: "w1", label: " Lotus ", cwd: "/x/lotus" },
      { id: "w2", label: "", cwd: "/x/api" },
    ],
    activeWorkspaceId: null,
    focusedCellId: null,
  }),
}));

const { TrackerBoardProvider, useSharedTrackerBoard } = await import("../TrackerBoardProvider");
const wrapper = ({ children }: { children: ReactNode }) => <TrackerBoardProvider>{children}</TrackerBoardProvider>;
const last = () => boardInputs[boardInputs.length - 1];

describe("TrackerBoardProvider (canvas-dock S4)", () => {
  it("names the saved workspaces until the shell publishes its own", async () => {
    const { result } = renderHook(() => useSharedTrackerBoard(), { wrapper });
    await waitFor(() => expect(last().projects).toEqual([{ id: "w1", name: "Lotus" }, { id: "w2", name: "api" }]));
    act(() => result.current.publishProjects([{ id: "w3", name: "web" }]));
    expect(last().projects).toEqual([{ id: "w3", name: "web" }]);
  });

  it("polls while a host shows Tasks", () => {
    const { result } = renderHook(() => useSharedTrackerBoard(), { wrapper });
    expect(last().tasksOpen).toBe(false);
    act(() => result.current.setViewing("canvas-dock", true));
    expect(last().tasksOpen).toBe(true);
    act(() => result.current.setViewing("canvas-dock", false));
    expect(last().tasksOpen).toBe(false);
  });

  it("records the canvas's task cells beside Code's panes (S4b)", () => {
    const { result } = renderHook(() => useSharedTrackerBoard(), { wrapper });
    const working = { activity: "working" as const, since: 1 };
    const asking = { activity: "needs-you" as const, since: 2 };
    act(() => result.current.publishActivities(new Map([["cell-1", working]])));
    act(() => result.current.publishCanvasActivities(new Map([["canvas:cp_1:node-1", asking]])));
    expect([...last().activities.keys()]).toEqual(["cell-1", "canvas:cp_1:node-1"]);
    expect(result.current.activities.get("canvas:cp_1:node-1")).toBe(asking);
    act(() => result.current.publishCanvasActivities(new Map()));
    expect([...last().activities.keys()]).toEqual(["cell-1"]);
  });
});
