import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/modules/codespace/components/types";

vi.mock("@/modules/codespace/services/bridge/cell-bus-context", () => ({
  useCellOutputTap: () => ({ takeEndedAgents: () => [], getDetectedProvider: () => null, subscribe: () => () => {} }),
}));

const { useFleetIdentitySync } = await import("@/modules/codespace/hooks/useFleetIdentitySync");

describe("fleet identity sync", () => {
  // Seen live: a new workspace with a Cursor and a Codex pane named both "Ivo".
  it("gives two new panes of one workspace two different names and addresses", () => {
    const cell = (id: string, agentCommand: string) => ({ id, cwd: "/r", type: "terminal", runtimeSessionId: null, runtimeStatus: "live", agentCommand });
    const workspace = { id: "w1", cwd: "/r", cells: [cell("a", "cursor-agent"), cell("b", "codex"), cell("c", "codex")] } as unknown as Workspace;
    const patches: Array<{ cellId: string; agentName?: string; agentAddress?: string }> = [];
    renderHook(() => useFleetIdentitySync([workspace], (_w, cellId, patch) => patches.push({ cellId, ...patch })));
    const names = patches.map((p) => p.agentName);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    expect(new Set(patches.map((p) => p.agentAddress)).size).toBe(3);
  });
});
