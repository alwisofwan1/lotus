import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import type { GridCell } from "@/modules/codespace/components/types";

const buses: CellBus[] = [];
vi.mock("@/modules/codespace/services/terminal-session-registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/codespace/services/terminal-session-registry")>();
  return {
    ...real,
    attachCellBus: (bus: CellBus) => {
      buses.push(bus);
      return real.attachCellBus(bus);
    },
  };
});

const { usePaneActivities } = await import("@/modules/workspace-shell/hooks/usePaneActivities");

const PANE = "cursor-pane";
const CELL = { id: PANE, cwd: "/repo", type: "terminal", runtimeStatus: "live", agentCommand: "cursor-agent --yolo" } as GridCell;
const emit = (event: "terminal:output" | "terminal:input", payload: object) =>
  act(() => buses.forEach((bus) => bus.emit(event, { paneId: PANE, workspaceId: "w1", ...payload } as never)));

describe("start error on a pane", () => {
  it("stays cleared after the human acts, even when the agent prints the old error again", () => {
    const { result } = renderHook(() => usePaneActivities({ cells: [CELL] }));

    emit("terminal:output", { data: "\x1b[31mError: Model unavailable on Free\x1b[0m" });
    expect(result.current.get(PANE)?.activity).toBe("failed");

    emit("terminal:input", { data: "halo\r", origin: "human", intent: "conversation-prompt", submitted: true });
    expect(result.current.get(PANE)?.activity).not.toBe("failed");

    // Seen live: after the answer cursor-agent printed the old error line again.
    emit("terminal:output", { data: "Error: Model unavailable on Free\r\nHalo. Ada yang bisa dibantu?" });
    expect(result.current.get(PANE)?.activity).not.toBe("failed");
  });
});
