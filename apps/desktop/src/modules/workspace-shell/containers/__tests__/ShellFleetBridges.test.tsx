import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const fleetPush = vi.fn();
const identitySync = vi.fn();
const spawnBridge = vi.fn();
const closeBridge = vi.fn();

vi.mock("@/modules/codespace/hooks/useMcpFleetPush", () => ({
  useMcpFleetPush: (...args: unknown[]) => fleetPush(...args),
}));
vi.mock("@/modules/codespace/hooks/useFleetIdentitySync", () => ({
  useFleetIdentitySync: (...args: unknown[]) => identitySync(...args),
}));
vi.mock("@/modules/codespace/hooks/useMcpSpawnBridge", () => ({
  useMcpSpawnBridge: (...args: unknown[]) => spawnBridge(...args),
}));
vi.mock("@/modules/codespace/hooks/useMcpCloseBridge", () => ({
  useMcpCloseBridge: (...args: unknown[]) => closeBridge(...args),
}));

import { paneLaunchesAgentDirectly, ShellFleetBridges } from "@/modules/workspace-shell/containers/ShellFleetBridges";
import type { Workspace } from "@/modules/codespace/components/types";

const WORKSPACES = [{ id: "w1", cwd: "/repo", cells: [] }] as unknown as Workspace[];

describe("the shell's MCP bridges", () => {
  it("mounts all four, because three of four is the failure nobody notices", () => {
    const onSpawn = vi.fn(() => "pane-1");
    const onClose = vi.fn(() => true);
    const updateTerminalAgentIdentity = vi.fn();

    render(
      <ShellFleetBridges
        workspaces={WORKSPACES}
        activeWorkspaceId="w1"
        updateTerminalAgentIdentity={updateTerminalAgentIdentity}
        onSpawn={onSpawn}
        onClose={onClose}
      />,
    );

    // The fleet is the window's, and the active workspace rides along so a reader can say which
    // folder the operator is in.
    expect(fleetPush).toHaveBeenCalledWith(WORKSPACES, "w1");
    expect(identitySync).toHaveBeenCalledWith(WORKSPACES, updateTerminalAgentIdentity, undefined);
    expect(spawnBridge).toHaveBeenCalledWith(onSpawn, expect.any(Function));
    expect(closeBridge).toHaveBeenCalledWith(onClose);
  });
});

/**
 * A source fence, in the shape `sessions-store-ownership.test.ts` already uses.
 *
 * The unit test above proves the component wires its four hooks; it cannot prove the SHELL mounts
 * that component, and a shell that does not is exactly the state this work exists to end — with
 * the symptom being silence, not an error: `lotus_list_fleet` answers an empty fleet and
 * `lotus_spawn_cell` times out. Reading the container is the cheapest way to keep that from
 * regressing unnoticed.
 */
describe("Code mode's mounting of them", () => {
  const source = readFileSync(
    resolve(__dirname, "../CodeMode.tsx"),
    "utf8",
  );

  it("mounts the bridges", () => {
    expect(source).toContain("<ShellFleetBridges");
  });

  it("puts them under a CellBusProvider, which every one of them needs", () => {
    // `useMcpFleetPush` and `useFleetIdentitySync` read the shared output tap from that context,
    // and `useMcpSpawnBridge` the bus itself; without it they throw rather than degrade.
    expect(source).toContain("<CellBusProvider");
  });
});

describe("paneLaunchesAgentDirectly", () => {
  const workspaces = [
    {
      id: "w1",
      cwd: "/repo",
      cells: [
        { id: "direct", type: "terminal", terminalCommand: ["claude", "--model", "opus"] },
        { id: "shell", type: "terminal", agentCommand: "codex --model x" },
        { id: "editor", type: "workbench" },
      ],
    },
  ] as unknown as Workspace[];

  it("is true only for a pane that runs its command as the PTY's process", () => {
    expect(paneLaunchesAgentDirectly(workspaces, "direct")).toBe(true);
    expect(paneLaunchesAgentDirectly(workspaces, "shell")).toBe(false);
    expect(paneLaunchesAgentDirectly(workspaces, "editor")).toBe(false);
  });

  it("does not guess for a pane it cannot find", () => {
    expect(paneLaunchesAgentDirectly(workspaces, "missing")).toBeUndefined();
  });
});
