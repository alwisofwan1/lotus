"use client";

import { useMcpFleetPush } from "@/modules/codespace/hooks/useMcpFleetPush";
import {
  useFleetIdentitySync,
  type UpdateTerminalAgentIdentity,
} from "@/modules/codespace/hooks/useFleetIdentitySync";
import { useMcpSpawnBridge } from "@/modules/codespace/hooks/useMcpSpawnBridge";
import { useMcpCloseBridge } from "@/modules/codespace/hooks/useMcpCloseBridge";
import type { Workspace } from "@/modules/codespace/components/types";

/**
 * The shell's half of the MCP contract.
 *
 * These four hooks are how a Lotus window is REACHABLE from outside itself — by the MCP sidecar,
 * by another agent, and by Lotus Pocket on the phone:
 *
 *  - `useMcpFleetPush` publishes who is in this window, which is the only thing
 *    `lotus_list_fleet` can answer from. Without it `lotus_dispatch_to_cell` has no address to
 *    send to either, because an address is a fleet member.
 *  - `useFleetIdentitySync` names the panes truthfully — the provider a cell is really running,
 *    read from its own output, rather than from the command someone typed.
 *  - `useMcpSpawnBridge` answers `mcp://spawn-cell`, the round trip `lotus_spawn_cell` and the
 *    phone's spawn both wait on. Rust emits the event and waits ~6s for a frontend to resolve it;
 *    with nobody listening the call does not fail loudly, it times out.
 *  - `useMcpCloseBridge` is the same arrangement for closing one.
 *
 * **Why they live here at all.** They were mounted in `CodeSpacePage`, which was the only surface
 * that owned workspaces. Since `/` became the main door that stopped being true, and measured on
 * 2026-09-21 the cost was exact: `POST /v1/list-fleet` answered `{"fleet":[],
 * "snapshot_age_ms":null}` — *no UI has ever pushed* — while a window full of running agents sat
 * on screen. Every MCP tool, every phone dispatch and every agent-to-agent message was blind.
 *
 * One component rather than four, because they share one precondition — a `CellBusProvider` above
 * them — and mounting three of four is the failure nobody would notice.
 */

export interface ShellFleetBridgesProps {
  /** Every workspace in the window: the fleet is the window's, not the showing folder's. */
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  updateTerminalAgentIdentity: UpdateTerminalAgentIdentity;
  /** A pane's agent exited back to its shell (its next prompt arrived). */
  onAgentEnded?: (workspaceId: string, paneId: string) => void;
  /**
   * Open a terminal pane running this command, and return its pane id.
   *
   * `null` means the window could not take the spawn (no workspace to put it in). The bridge
   * reports that back to Rust as a refusal, which is what lets a caller try another window
   * instead of waiting out the timeout.
   */
  onSpawn: (agentCommand: string, workspaceId?: string, claudeAccount?: string, fromPaneId?: string) => string | null;
  /** Close a pane by id. `false` when this window does not have it. */
  onClose: (paneId: string) => boolean;
}

export function ShellFleetBridges({
  workspaces,
  activeWorkspaceId,
  updateTerminalAgentIdentity,
  onAgentEnded,
  onSpawn,
  onClose,
}: ShellFleetBridgesProps) {
  useMcpFleetPush(workspaces, activeWorkspaceId);
  useFleetIdentitySync(workspaces, updateTerminalAgentIdentity, onAgentEnded);
  // The hook keeps the latest of this callback, so it sees the spawned pane once it has rendered.
  useMcpSpawnBridge(onSpawn, (paneId) => paneLaunchesAgentDirectly(workspaces, paneId));
  useMcpCloseBridge(onClose);
  return null;
}

/**
 * A pane with a `terminalCommand` runs it as the PTY's process: the agent itself locally, or ssh
 * running the agent before any remote shell (`ssh-command.ts`). Without one, a shell starts and the
 * agent command is typed into it. Undefined when the pane is not in these workspaces.
 */
export function paneLaunchesAgentDirectly(workspaces: readonly Workspace[], paneId: string): boolean | undefined {
  for (const workspace of workspaces) {
    const cell = workspace.cells.find((candidate) => candidate.id === paneId);
    if (cell) return cell.type === "terminal" && (cell.terminalCommand?.length ?? 0) > 0;
  }
  return undefined;
}
