import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import type { PaneActivity } from "@/modules/workspace-shell/types";

const api = vi.hoisted(() => ({
  getPaneAgentTitle: vi.fn(),
  generatePaneTitle: vi.fn(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("@/lib/tauri-api", () => api);

import { usePaneAutoTitles } from "@/modules/workspace-shell/hooks/usePaneAutoTitles";

/**
 * The wiring: a settled turn asks Rust what the pane's conversation is called, and the answer
 * reaches the writer with the conversation's key. Rules live in `planPaneTitle`'s own tests.
 */

const KEY = "/u/.claude/projects/-x/s1.jsonl";
const cell = (patch: Partial<GridCell> = {}) =>
  ({ id: "pane-1", type: "terminal", cwd: "/u/Lotus", agentCommand: "claude", ...patch }) as GridCell;
const workspace = (c: GridCell) => [{ id: "ws", cells: [c] } as unknown as Workspace];
const at = (activity: PaneActivity) => new Map<string, PaneActivityState>([["pane-1", { activity, since: 0 }]]);

function settle(c: GridCell) {
  const onTitle = vi.fn();
  const hook = renderHook(
    ({ activities }) => usePaneAutoTitles({ workspaces: workspace(c), activities, onTitle }),
    { initialProps: { activities: at("working") } },
  );
  hook.rerender({ activities: at("idle") });
  return onTitle;
}

describe("usePaneAutoTitles", () => {
  beforeEach(() => {
    api.getPaneAgentTitle.mockReset();
    api.generatePaneTitle.mockReset();
  });

  it("takes the agent's own title without asking a model", async () => {
    api.getPaneAgentTitle.mockResolvedValue({ sessionKey: KEY, title: "Fitur auto title", hasPrompt: true });
    const onTitle = settle(cell({ title: "Old", titleStatus: "ready", titleSessionKey: "/old.jsonl" } as Partial<GridCell>));
    await waitFor(() => expect(onTitle).toHaveBeenCalled());
    expect(api.getPaneAgentTitle).toHaveBeenCalledWith("pane-1");
    expect(onTitle.mock.calls[0]).toEqual(["ws", "pane-1", expect.objectContaining({ title: "Fitur auto title", sessionKey: KEY })]);
    expect(api.generatePaneTitle).not.toHaveBeenCalled();
  });

  it("asks a model by pane, not by PTY session, when the agent wrote no title", async () => {
    api.getPaneAgentTitle.mockResolvedValue({ sessionKey: KEY, hasPrompt: true });
    api.generatePaneTitle.mockResolvedValue({ title: "Fix login flow", source: "ai" });
    const onTitle = settle(cell());
    await waitFor(() => expect(onTitle).toHaveBeenCalledWith("ws", "pane-1", expect.objectContaining({ title: "Fix login flow", status: "ready", sessionKey: KEY })));
    expect(api.generatePaneTitle).toHaveBeenCalledWith(expect.objectContaining({ paneId: "pane-1", provider: "claude" }));
  });

  it("drops a CLI error the model returned instead of a title", async () => {
    api.getPaneAgentTitle.mockResolvedValue({ sessionKey: KEY, hasPrompt: true });
    api.generatePaneTitle.mockResolvedValue({ title: "You've hit your weekly limit", source: "ai" });
    const onTitle = settle(cell());
    await waitFor(() => expect(api.generatePaneTitle).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(onTitle).not.toHaveBeenCalled();
  });

  it("does nothing for a pane with no known transcript", async () => {
    api.getPaneAgentTitle.mockResolvedValue(null);
    const onTitle = settle(cell());
    await waitFor(() => expect(api.getPaneAgentTitle).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(onTitle).not.toHaveBeenCalled();
    expect(api.generatePaneTitle).not.toHaveBeenCalled();
  });
});
