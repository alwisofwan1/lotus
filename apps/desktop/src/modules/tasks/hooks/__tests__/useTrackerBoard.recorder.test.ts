import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTrackerBoard, type UseTrackerBoardInput } from "@/modules/tasks/hooks/useTrackerBoard";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";

/**
 * What a pane did is written into its task whether or not the Tasks panel is open.
 *
 * The recorder used to live in the panel, and a Delegate that worked CLOSES the panel — so the
 * moment most worth recording, the agent finishing, happened while nothing was listening. The
 * board is always mounted (the rail's count reads it), so the board records.
 */

const client = vi.hoisted(() => ({
  list: vi.fn(async () => [
    {
      id: "t1", workspaceId: "ws-1", number: 1, title: "Delegated", goal: "g", knowledge: "",
      status: "in-progress", priority: "none", assignees: [], createdAt: 1, updatedAt: 1, cellId: "p1",
    },
  ]),
  update: vi.fn(async () => ({})),
  appendEvent: vi.fn(async () => ({})),
}));

vi.mock("@/modules/codespace/services/bridge/task-api", () => ({ createTauriTaskClient: () => client }));
vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => true, tauriInvoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const base: Omit<UseTrackerBoardInput, "activities"> = {
  projects: [{ id: "ws-1", name: "Lotus" }],
  storedPrefixes: { "ws-1": "LOT" },
  onPrefixesChange: () => {},
};

const panes = (activity: PaneActivityState["activity"]) =>
  new Map<string, PaneActivityState>([["p1", { activity, since: 0 }]]);

describe("recording what the panes did", () => {
  it("writes the ending into the task and releases its pane, with no panel open", async () => {
    const { result, rerender } = renderHook((activities) => useTrackerBoard({ ...base, activities }), {
      initialProps: panes("working"),
    });
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    rerender(panes("done"));

    await waitFor(() =>
      expect(client.appendEvent).toHaveBeenCalledWith(
        "ws-1",
        "t1",
        expect.objectContaining({ actor: "system", kind: "agent-result" }),
      ),
    );
    expect(client.update).toHaveBeenCalledWith("ws-1", "t1", { cellId: null });
  });
});
