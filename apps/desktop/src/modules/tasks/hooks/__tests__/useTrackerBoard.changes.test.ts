import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTrackerBoard, type UseTrackerBoardInput } from "@/modules/tasks/hooks/useTrackerBoard";

/**
 * An agent writing through the MCP tools changes a task this window did not touch. Rust says so
 * with `tasks://changed`, and the board re-reads THAT workspace — not every one, and not only when
 * somebody remembers to press Refresh.
 */

const store = vi.hoisted(() => ({
  titles: { "ws-1": "First", "ws-2": "Second" } as Record<string, string>,
}));

const client = vi.hoisted(() => ({
  list: vi.fn(async (workspaceId: string) => [
    {
      id: `${workspaceId}-t1`, workspaceId, number: 1, title: store.titles[workspaceId], goal: "g",
      knowledge: "", status: "todo", priority: "none", assignees: [], createdAt: 1, updatedAt: 1,
    },
  ]),
  update: vi.fn(async () => ({})),
  appendEvent: vi.fn(async () => ({})),
}));

const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@/modules/codespace/services/bridge/task-api", () => ({ createTauriTaskClient: () => client }));
vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => true, tauriInvoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    events.set(name, handler);
    return () => events.delete(name);
  }),
}));

const input: UseTrackerBoardInput = {
  projects: [
    { id: "ws-1", name: "Lotus" },
    { id: "ws-2", name: "Interviews" },
  ],
  storedPrefixes: { "ws-1": "LOT", "ws-2": "INT" },
  onPrefixesChange: () => {},
};

beforeEach(() => {
  client.list.mockClear();
  store.titles = { "ws-1": "First", "ws-2": "Second" };
});

describe("a task changed outside this window", () => {
  it("re-reads only the workspace it happened in", async () => {
    const { result } = renderHook(() => useTrackerBoard(input));
    await waitFor(() => expect(result.current.tasks).toHaveLength(2));
    await waitFor(() => expect(events.has("tasks://changed")).toBe(true));
    client.list.mockClear();

    store.titles["ws-2"] = "Renamed by an agent";
    act(() => events.get("tasks://changed")!({ payload: { workspaceId: "ws-2", taskId: "ws-2-t1" } }));

    await waitFor(() =>
      expect(result.current.tasks.map((task) => task.title)).toEqual(["First", "Renamed by an agent"]),
    );
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.list).toHaveBeenCalledWith("ws-2", {});
  });

  it("says which task changed, so an open one can read itself again", async () => {
    const { result } = renderHook(() => useTrackerBoard(input));
    await waitFor(() => expect(events.has("tasks://changed")).toBe(true));

    act(() => events.get("tasks://changed")!({ payload: { workspaceId: "ws-1", taskId: "ws-1-t1" } }));

    await waitFor(() => expect(result.current.lastChange?.taskId).toBe("ws-1-t1"));
  });
});
