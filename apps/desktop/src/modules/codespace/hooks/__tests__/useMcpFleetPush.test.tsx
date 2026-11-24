import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalCellData, Workspace } from "@/modules/codespace/components/types";
import {
  CellBusProvider,
  useCellBus,
  useCellOutputTap,
} from "@/modules/codespace/services/bridge/cell-bus-context";
import type { CellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import type { FleetOutputTap } from "@/modules/codespace/services/bridge/fleet-output-tap";
import {
  publishableAliases,
  useMcpFleetPush,
  workspaceLabelFromCwd,
} from "../useMcpFleetPush";
import { useFleetIdentitySync, type UpdateTerminalAgentIdentity } from "../useFleetIdentitySync";

const bridgePushFleetSnapshot = vi.fn(async (snapshot: unknown, active?: unknown) => {
  void snapshot;
  void active;
});
const getAllTerminalSessions = vi.fn(() => [{
  paneId: "pane-1",
  workspaceId: "workspace-1",
  cwd: "/repo",
  status: "live" as const,
  sessionId: "session-1",
}]);

vi.mock("@/lib/tauri-api", () => ({
  bridgePushFleetSnapshot: (snapshot: unknown, active?: unknown) =>
    bridgePushFleetSnapshot(snapshot, active),
}));

vi.mock("@/modules/codespace/services/terminal-session-registry", async () => {
  const actual = await vi.importActual<typeof import("@/modules/codespace/services/terminal-session-registry")>(
    "@/modules/codespace/services/terminal-session-registry",
  );
  return {
    ...actual,
    getAllTerminalSessions: () => getAllTerminalSessions(),
  };
});

/* The settings slice is three fields now, read straight off the reader — no `orchestration`
   wrapper, because the Bridge tree it belonged to is gone. */
const FLEET_SETTINGS = {
  includeExitedInFleet: false,
  forceFleetSnapshotOnSpawn: true,
  fleetPushDebounceMs: 1,
};

vi.mock("@/modules/codespace/hooks/useFleetSettings", () => ({
  useFleetSettings: () => ({ current: FLEET_SETTINGS, read: () => FLEET_SETTINGS }),
}));

// The Claude pane exits and Codex starts in its shell (OSC 133;C): only then may a banner relabel it.
const CODEX_RELAUNCH = ["Claude Code\n> ", "\x1b]133;C\x07", ">_ OpenAI Codex (v0.154.0)\n"];

function makeWorkspace(cwd = "/repo"): Workspace {
  return {
    id: "workspace-1",
    label: "Workspace",
    color: "#4F8CFF",
    cwd,
    rows: 1,
    cols: 1,
    cells: [{
      id: "pane-1",
      type: "terminal",
      cwd: "/repo",
      agentCommand: "claude",
    }],
  };
}

function makeWorkspaceWithTitle(title: string, titleStatus: TerminalCellData["titleStatus"]): Workspace {
  const ws = makeWorkspace();
  return {
    ...ws,
    cells: [{ ...(ws.cells[0] as TerminalCellData), title, titleStatus }],
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <CellBusProvider workspaceId="workspace-1">{children}</CellBusProvider>;
}

function useHarness(workspaces: readonly Workspace[], activeWorkspaceId?: string | null) {
  useMcpFleetPush(workspaces, activeWorkspaceId);
  return useCellBus();
}

describe("useMcpFleetPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not push duplicate fleet snapshots for unchanged status events", async () => {
    const workspaces = [makeWorkspace()];
    const { result } = renderHook(() => useHarness(workspaces), { wrapper });

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.emit("terminal:status", { paneId: "pane-1", status: "live" });
      result.current.emit("terminal:status", { paneId: "pane-1", status: "live" });
      result.current.emit("terminal:status", { paneId: "pane-1", status: "live" });
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1);
  });

  // The Rust side has matched on `agent_address` and `aliases` since RC-3, but this push never
  // sent either — so every codespace cell reached lotus_list_fleet with a pane UUID as its only
  // addressable name. Assert on the wire payload, which is the thing that was wrong.
  it("publishes the readable address and aliases so a peer can be named, not just UUID'd", async () => {
    renderHook(() => useHarness([makeWorkspace()]), { wrapper });

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));

    const pushed = bridgePushFleetSnapshot.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(pushed).toHaveLength(1);
    expect(pushed[0].pane_id).toBe("pane-1");
    expect(pushed[0].agent_address).toBe("claude-1");
    expect(pushed[0].aliases).toContain("claude-1");
    expect(pushed[0].workspace_label).toBe("repo");
  });

  // Scoping is only a safety mechanism if Rust is actually told what the operator is looking at.
  // Nothing else carries it: `active_workspace_id` exists in the app but had zero hits in
  // mcp_ipc.rs, so every list_fleet answer swept all workspaces.
  it("tells Rust which workspace the operator is in, alongside the fleet", async () => {
    renderHook(() => useHarness([makeWorkspace()], "workspace-1"), { wrapper });

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));

    expect(bridgePushFleetSnapshot.mock.calls[0][1]).toBe("workspace-1");
  });

  // The de-dupe is keyed on the payload, and switching workspace can leave the fleet byte-identical
  // — same cells, same statuses. Without the scope in the signature the push that MOVES the scope
  // is the exact one swallowed, leaving list_fleet answering for the workspace just left.
  it("still pushes when only the active workspace changed", async () => {
    const workspaces = [makeWorkspace()];
    const { rerender } = renderHook(
      ({ active }: { active: string }) => useHarness(workspaces, active),
      { wrapper, initialProps: { active: "workspace-1" } },
    );

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));

    rerender({ active: "workspace-2" });

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(2));
    expect(bridgePushFleetSnapshot.mock.calls[1][1]).toBe("workspace-2");
    // Same fleet both times — only the scope moved.
    expect(bridgePushFleetSnapshot.mock.calls[1][0]).toEqual(
      bridgePushFleetSnapshot.mock.calls[0][0],
    );
  });

  // "Claude" is what all five cells are called, so publishing it as an alias widens the very
  // ambiguity the address exists to remove.
  it("leaves the generic provider label out of the published aliases", async () => {
    renderHook(() => useHarness([makeWorkspace()]), { wrapper });

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));

    const pushed = bridgePushFleetSnapshot.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(pushed[0].aliases).not.toContain("Claude");
  });

  // The evidence line this slice was asked for, asserted where it actually matters: on the wire
  // payload, not on the helper in isolation. An empty `workspace_label` would be a name, and a
  // blank one; the Rust contract reads an ABSENT key as "this host cannot name the project".
  it("drops workspace_label from the pushed payload when the workspace cwd is empty", async () => {
    renderHook(() => useHarness([makeWorkspace("")]), { wrapper });

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));

    const pushed = bridgePushFleetSnapshot.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(pushed).toHaveLength(1);
    expect("workspace_label" in pushed[0]).toBe(false);
    // The rest of the identity still travels — an unnamed project is not an unnamed cell.
    expect(pushed[0].agent_address).toBe("claude-1");
  });

  // Slice 02 §6: the conversation title travels as `headline`, never as `display_name` — a
  // title can be regenerated at any time, and a name that changes on its own would defeat the
  // one thing that makes a name useful.
  it("(02) sends the ready title as headline", async () => {
    renderHook(() => useHarness([makeWorkspaceWithTitle("Refactor the login flow", "ready")]), { wrapper });

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));
    const pushed = bridgePushFleetSnapshot.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(pushed[0].headline).toBe("Refactor the login flow");
  });

  it("(02) omits the headline key entirely for a non-ready title, rather than sending a stale string", async () => {
    renderHook(() => useHarness([makeWorkspaceWithTitle("Refactor the login flow", "generating")]), { wrapper });

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));
    const pushed = bridgePushFleetSnapshot.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect("headline" in pushed[0]).toBe(false);
  });

  it("(02) omits the headline key when there is no title at all", async () => {
    renderHook(() => useHarness([makeWorkspace()]), { wrapper });

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));
    const pushed = bridgePushFleetSnapshot.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect("headline" in pushed[0]).toBe(false);
  });

  // `flush()` is not wrapped in a try/catch, so a throw here silently kills the fleet push for
  // every workspace, not just the malformed one.
  it("survives a persisted workspace whose cwd is missing entirely", () => {
    expect(() => workspaceLabelFromCwd(undefined)).not.toThrow();
    expect(workspaceLabelFromCwd(undefined)).toBeUndefined();
  });

  it("omits a key rather than sending a blank one when the host cannot name the project", () => {
    expect(workspaceLabelFromCwd("")).toBeUndefined();
    expect(workspaceLabelFromCwd("   ")).toBeUndefined();
    expect(workspaceLabelFromCwd("/Users/me/workspace/Lotus/")).toBe("Lotus");
  });

  it("keeps the Agent Handle as an alias, since that one does distinguish", () => {
    expect(
      publishableAliases({
        aliases: ["claude-2", "Kai", "Claude"],
        displayName: "Kai",
        agentName: "Kai",
      }),
    ).toEqual(["claude-2", "Kai", "Claude"]);
    expect(
      publishableAliases({ aliases: ["claude-2", "Claude"], displayName: "Claude" }),
    ).toEqual(["claude-2"]);
  });
});

// (07) useMcpFleetPush and useFleetIdentitySync now read one tap shared via <CellBusProvider>,
// instead of each calling createFleetOutputTap(bus) itself. These tests exercise the real
// production hooks together, not a stand-in — that's the only way to prove the two
// consumers actually share state instead of merely compiling against the same context API.
describe("(07) shared output tap", () => {
  function FleetPushProbe({ workspaces }: { workspaces: Workspace[] }) {
    useMcpFleetPush(workspaces);
    return null;
  }

  function IdentitySyncProbe({
    workspaces,
    onUpdate,
  }: {
    workspaces: Workspace[];
    onUpdate: UpdateTerminalAgentIdentity;
  }) {
    useFleetIdentitySync(workspaces, onUpdate);
    return null;
  }

  function BusCapture({ onBus }: { onBus: (bus: CellBus) => void }) {
    onBus(useCellBus());
    return null;
  }

  function TapCapture({ onTap }: { onTap: (tap: FleetOutputTap) => void }) {
    onTap(useCellOutputTap());
    return null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a single terminal:output event updates both consumers from one shared tap", async () => {
    const workspaces = [makeWorkspace()];
    const onUpdate = vi.fn();
    let bus!: CellBus;

    render(
      <CellBusProvider workspaceId="workspace-1">
        <BusCapture onBus={(b) => (bus = b)} />
        <FleetPushProbe workspaces={workspaces} />
        <IdentitySyncProbe workspaces={workspaces} onUpdate={onUpdate} />
      </CellBusProvider>,
    );

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));
    bridgePushFleetSnapshot.mockClear();

    act(() => {
      for (const data of CODEX_RELAUNCH) bus.emit("terminal:output", { paneId: "pane-1", workspaceId: "workspace-1", data });
    });

    // useFleetIdentitySync's side of the SAME notification.
    expect(onUpdate).toHaveBeenCalledWith(
      "workspace-1",
      "pane-1",
      expect.objectContaining({ runtimeProvider: "codex" }),
    );
    // useMcpFleetPush's side of the SAME notification (its own debounced push).
    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalled());
    const pushed = bridgePushFleetSnapshot.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
    expect(pushed[0].provider).toBe("codex");
  });

  // The most important test in this task: before 07, each hook called tap.dispose() on its
  // own unmount. With a shared tap, that would wipe the buffer/provider map/switch window
  // out from under whichever consumer was still mounted.
  it("unmounting one consumer does not clear the shared tap's state for the other", async () => {
    const workspaces = [makeWorkspace()];
    const onUpdate = vi.fn();
    let bus!: CellBus;
    let tap!: FleetOutputTap;

    const { rerender } = render(
      <CellBusProvider workspaceId="workspace-1">
        <BusCapture onBus={(b) => (bus = b)} />
        <TapCapture onTap={(t) => (tap = t)} />
        <FleetPushProbe workspaces={workspaces} />
        <IdentitySyncProbe workspaces={workspaces} onUpdate={onUpdate} />
      </CellBusProvider>,
    );

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));

    act(() => {
      for (const data of CODEX_RELAUNCH) bus.emit("terminal:output", { paneId: "pane-1", workspaceId: "workspace-1", data });
    });
    expect(tap.getDetectedProvider("pane-1")).toBe("codex");

    // Unmount ONLY the identity-sync consumer — useMcpFleetPush and the provider stay up.
    // Before 07, IdentitySyncProbe's underlying hook called tap.dispose() on its own
    // cleanup; with a shared tap that would wipe this exact state out from under
    // useMcpFleetPush, which is still mounted and still reading the same tap.
    rerender(
      <CellBusProvider workspaceId="workspace-1">
        <BusCapture onBus={(b) => (bus = b)} />
        <TapCapture onTap={(t) => (tap = t)} />
        <FleetPushProbe workspaces={workspaces} />
      </CellBusProvider>,
    );

    expect(tap.getDetectedProvider("pane-1")).toBe("codex");
  });

  it("a consumer that mounts LATER immediately sees a provider already detected before it existed", async () => {
    const workspaces = [makeWorkspace()];
    let bus!: CellBus;

    const { rerender } = render(
      <CellBusProvider workspaceId="workspace-1">
        <BusCapture onBus={(b) => (bus = b)} />
        <FleetPushProbe workspaces={workspaces} />
      </CellBusProvider>,
    );

    await waitFor(() => expect(bridgePushFleetSnapshot).toHaveBeenCalledTimes(1));
    act(() => {
      for (const data of CODEX_RELAUNCH) bus.emit("terminal:output", { paneId: "pane-1", workspaceId: "workspace-1", data });
    });
    await waitFor(() => {
      const pushed = bridgePushFleetSnapshot.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
      expect(pushed[0].provider).toBe("codex");
    });

    // Mount useFleetIdentitySync now — well after the banner already arrived. Before 07, a
    // freshly-created tap for this hook would start empty and never see that banner again.
    const onUpdate = vi.fn();
    rerender(
      <CellBusProvider workspaceId="workspace-1">
        <BusCapture onBus={(b) => (bus = b)} />
        <FleetPushProbe workspaces={workspaces} />
        <IdentitySyncProbe workspaces={workspaces} onUpdate={onUpdate} />
      </CellBusProvider>,
    );

    // No new terminal:output event — the already-known provider must surface immediately.
    expect(onUpdate).toHaveBeenCalledWith(
      "workspace-1",
      "pane-1",
      expect.objectContaining({ runtimeProvider: "codex" }),
    );
  });
});
