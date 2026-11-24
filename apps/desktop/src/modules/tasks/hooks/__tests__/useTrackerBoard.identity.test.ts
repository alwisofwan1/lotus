import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTrackerBoard, type UseTrackerBoardInput } from "@/modules/tasks/hooks/useTrackerBoard";

/**
 * The board is one object the whole window shares, and it is a dependency everywhere below it —
 * the panel's memo, the delegation hook's spawner, the ticket editor's re-read. A new object on
 * every render of the shell rebuilds all of those for nothing, so it keeps its identity until
 * something it carries has actually changed.
 */

vi.mock("@/modules/codespace/services/bridge/task-api", () => ({
  createTauriTaskClient: () => ({
    list: vi.fn().mockResolvedValue([
      {
        id: "t1", workspaceId: "ws-1", number: 1, title: "A task", goal: "g", knowledge: "",
        status: "todo", priority: "none", assignees: [], createdAt: 1, updatedAt: 1,
      },
    ]),
  }),
}));

const input: UseTrackerBoardInput = {
  projects: [{ id: "ws-1", name: "Lotus" }],
  storedPrefixes: { "ws-1": "LOT" },
  onPrefixesChange: () => {},
};

describe("the board's identity", () => {
  it("is the same object across a render that changed nothing", async () => {
    const { result, rerender } = renderHook(() => useTrackerBoard(input));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    const before = result.current;
    rerender();

    expect(result.current).toBe(before);
  });

  it("is a new object once what it carries changed", async () => {
    const { result } = renderHook(() => useTrackerBoard(input));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    const before = result.current;
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current).not.toBe(before));
  });
});
