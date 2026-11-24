import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneActivities } from "@/modules/workspace-shell/hooks/usePaneActivities";
import { agentTurnRegistry } from "@/modules/codecanvas/services/agent-turn-registry";
import { threadActivityRegistry } from "@/modules/codespace/state/thread-activity-registry";
import {
  noteTerminalOutputChunk,
  noteTerminalUserInput,
  resetTerminalActivity,
} from "@/modules/codespace/services/terminal-activity-registry";
import {
  registerTerminalSession,
  writeTerminalSession,
} from "@/modules/codespace/services/terminal-session-registry";
import type { GridCell } from "@/modules/codespace/components/types";

/**
 * The join, end to end, with the REAL registries.
 *
 * Every piece below is unit-tested on its own; what this file proves is that they are actually
 * wired to each other — that a byte arriving at the activity registry, a hook fact landing from
 * Rust, and a human pressing Enter each reach the map the rail draws from. Those three
 * subscriptions are the part that silently does nothing if a name is wrong.
 */

const PANE = "pane-1";
const AGENT_CELL: GridCell = {
  id: PANE,
  cwd: "/repo",
  type: "terminal",
  runtimeStatus: "live",
  agentCommand: "claude",
} as GridCell;

function renderActivities(cells: GridCell[]) {
  return renderHook(
    ({ list }: { list: GridCell[] }) =>
      usePaneActivities({ cells: list }),
    { initialProps: { list: cells } },
  );
}

beforeEach(() => {
  resetTerminalActivity(PANE);
  agentTurnRegistry.clear(PANE);
  threadActivityRegistry.clear("s1");
});

afterEach(() => {
  vi.useRealTimers();
  resetTerminalActivity(PANE);
  agentTurnRegistry.clear(PANE);
});

describe("pane activities, wired to the real registries", () => {
  it("starts a live agent pane at rest", () => {
    const { result } = renderActivities([AGENT_CELL]);
    expect(result.current.get(PANE)?.activity).toBe("idle");
  });

  it("follows the terminal activity registry when the PTY starts working", () => {
    const { result } = renderActivities([AGENT_CELL]);

    act(() => {
      // What the v2 runtime calls on Enter; the agent's reply then reads as `running`.
      noteTerminalUserInput(PANE, { data: "hi\r", submitted: true, agentTurnCandidate: true });
      noteTerminalOutputChunk(PANE, "thinking…");
    });

    expect(result.current.get(PANE)?.activity).toBe("working");
  });

  it("raises an ask when a hook fact lands, over a quiet pane", () => {
    const { result } = renderActivities([AGENT_CELL]);

    act(() => {
      agentTurnRegistry.record({ paneId: PANE, turn: "needs-input", atMs: Date.now() });
    });

    expect(result.current.get(PANE)?.activity).toBe("needs-you");
  });

  it("retracts the ask when a human submits into that pane", () => {
    // The rejection path: no further hook will fire, so the submit is the only proof. This is the
    // subscription most likely to be silently broken — it travels through an attached CellBus.
    const { result } = renderActivities([AGENT_CELL]);
    const unregister = registerTerminalSession(PANE, {
      workspaceId: "w1",
      cwd: "/repo",
      status: "live",
      close: () => {},
      write: () => {},
      resize: () => {},
      getSessionId: () => "s-1",
    });

    act(() => {
      agentTurnRegistry.record({ paneId: PANE, turn: "needs-input", atMs: Date.now() - 1_000 });
    });
    expect(result.current.get(PANE)?.activity).toBe("needs-you");

    act(() => {
      writeTerminalSession(PANE, "y\r", { origin: "human", submitted: true });
    });

    expect(result.current.get(PANE)?.activity).toBe("idle");
    unregister();
  });

  it("ignores a programmatic write — only a human answers an ask", () => {
    const { result } = renderActivities([AGENT_CELL]);
    const unregister = registerTerminalSession(PANE, {
      workspaceId: "w1",
      cwd: "/repo",
      status: "live",
      close: () => {},
      write: () => {},
      resize: () => {},
      getSessionId: () => "s-1",
    });

    act(() => {
      agentTurnRegistry.record({ paneId: PANE, turn: "needs-input", atMs: Date.now() - 1_000 });
      // A resize echo, an MCP dispatch, a startup command: none of them is a person deciding.
      writeTerminalSession(PANE, "ls\r", { origin: "mcp", submitted: true });
    });

    expect(result.current.get(PANE)?.activity).toBe("needs-you");
    unregister();
  });

  it("follows a conversation's streaming state", () => {
    const chatCell = { id: "chat-1", cwd: "/repo", type: "chat", sessionId: "", thread: { id: null } } as GridCell;
    const { result } = renderActivities([chatCell]);

    expect(result.current.get("chat-1")?.activity).toBe("idle");

    act(() => threadActivityRegistry.setStreaming("chat-1", true));
    expect(result.current.get("chat-1")?.activity).toBe("working");

    act(() => threadActivityRegistry.setStreaming("chat-1", false));
    expect(result.current.get("chat-1")?.activity).toBe("idle");
  });

  it("keeps the stamp while a state holds, so an age can count from it", () => {
    const { result } = renderActivities([AGENT_CELL]);
    const first = result.current.get(PANE);

    act(() => {
      agentTurnRegistry.record({ paneId: PANE, turn: "running", atMs: Date.now() });
    });
    const working = result.current.get(PANE);

    act(() => {
      // A second fact of the same kind changes nothing observable about the state.
      agentTurnRegistry.record({ paneId: PANE, turn: "running", atMs: Date.now() + 1 });
    });

    expect(first?.activity).toBe("idle");
    expect(working?.activity).toBe("working");
    // Same object: the row does not re-render, and the age does not restart.
    expect(result.current.get(PANE)).toBe(working);
  });

  it("forgets a pane that has been closed", () => {
    const { result, rerender } = renderActivities([AGENT_CELL]);
    expect(result.current.has(PANE)).toBe(true);

    rerender({ list: [] });

    expect(result.current.has(PANE)).toBe(false);
  });

  it("traces a pane once while its state holds, however much time passes between renders", () => {
    vi.useFakeTimers();
    window.localStorage.removeItem("lotus:pane-activity-trace");
    agentTurnRegistry.record({ paneId: PANE, turn: "running", atMs: Date.now() });
    const { rerender } = renderActivities([AGENT_CELL]);
    const traceLines = () =>
      (window.localStorage.getItem("lotus:pane-activity-trace") ?? "").split("\n").filter(Boolean);
    const settled = traceLines().length;

    // The fact's age grows on every render; only a change of state may add a line.
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        vi.advanceTimersByTime(1_000);
        rerender({ list: [{ ...AGENT_CELL }] });
      });
    }

    expect(settled).toBeGreaterThan(0);
    expect(traceLines()).toHaveLength(settled);
  });
});
