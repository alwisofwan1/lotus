"use client";

import { useEffect, useRef } from "react";
import type {
  ExecutorProviderId,
  Workspace,
} from "@/modules/codespace/components/types";
import { useCellOutputTap } from "@/modules/codespace/services/bridge/cell-bus-context";
import { promoteFleetTargetIdentity } from "@/modules/codespace/services/bridge/fleet-identity-sync";
import { detectFleetProvider } from "@/modules/codespace/services/bridge/fleet-naming";
import { findSpec } from "@/modules/codespace/services/bridge/agent-registry";

/** The interactive agent a launch command starts, or null for a shell or a custom command. */
export function launchedProvider(agentCommand: string | undefined): ExecutorProviderId | null {
  const provider = detectFleetProvider(agentCommand);
  const spec = provider === "shell" ? undefined : findSpec(provider);
  return spec && !spec.isHeadless ? (spec.id as ExecutorProviderId) : null;
}
import { shuffled } from "@/lib/agent-catalog";
import { currentNamePool } from "@/lib/agent-naming";

export type UpdateTerminalAgentIdentity = (
  workspaceId: string,
  cellId: string,
  patch: {
    agentAddress?: string;
    legacyAgentAddresses?: string[];
    runtimeProvider?: ExecutorProviderId;
    agentAddressCounters?: Record<string, number>;
    agentName?: string;
  },
) => void;

export function useFleetIdentitySync(
  workspaces: readonly Workspace[],
  updateTerminalAgentIdentity: UpdateTerminalAgentIdentity,
  /** A pane's agent exited back to its shell: the pane stops being that agent. */
  onAgentEnded?: (workspaceId: string, cellId: string) => void,
): void {
  // (07) Shared with useMcpFleetPush via <CellBusProvider> — not created here anymore.
  const tap = useCellOutputTap();
  const workspacesRef = useRef(workspaces);
  const updateRef = useRef(updateTerminalAgentIdentity);
  const endedRef = useRef(onAgentEnded);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    updateRef.current = updateTerminalAgentIdentity;
    endedRef.current = onAgentEnded;
  }, [updateTerminalAgentIdentity, onAgentEnded]);

  useEffect(() => {
    // (Slice 02) Resolved once per tap/mount, not inside the loop below — `promoteFleetTargetIdentity`
    // stays a pure function of (workspace, cellId, provider, pool), so it never reads settings itself.
    // (Slice 03) Shuffled here too — not inside name-pool.ts, whose determinism is a
    // deliberate, tested contract.
    const pool = shuffled(currentNamePool());

    const sync = () => {
      for (const paneId of tap.takeEndedAgents()) {
        const workspace = workspacesRef.current.find((candidate) => candidate.cells.some((cell) => cell.id === paneId));
        if (workspace) endedRef.current?.(workspace.id, paneId);
      }
      for (const original of workspacesRef.current) {
        // Carried forward: the ref updates only after a render, so two new panes promoted in
        // one pass both saw no names taken and were both called "Ivo" (seen live, 2026-11-20).
        let workspace = original;
        for (const cell of original.cells) {
          if (cell.type !== "terminal") continue;
          // The output's word first (a handoff), else the agent the pane was launched with: a CLI
          // whose banner the tap never saw (Pi behind its skill list) still gets its name.
          const provider = tap.getDetectedProvider(cell.id, cell.agentCommand) ?? launchedProvider(cell.agentCommand);
          if (!provider) continue;
          const next = promoteFleetTargetIdentity(workspace, cell.id, provider, pool);
          if (next === workspace) continue;
          const nextCell = next.cells.find((candidate) => candidate.id === cell.id);
          if (!nextCell || nextCell.type !== "terminal") continue;
          updateRef.current(workspace.id, cell.id, {
            agentAddress: nextCell.agentAddress,
            legacyAgentAddresses: nextCell.legacyAgentAddresses,
            runtimeProvider: nextCell.runtimeProvider,
            agentAddressCounters: next.agentAddressCounters,
            agentName: nextCell.agentName,
          });
          workspace = next;
        }
      }
    };

    // (07) `tap` is shared, so it may already know a pane's provider before this hook ever
    // mounts (e.g. useMcpFleetPush's earlier subscription already saw the banner). Run once
    // immediately instead of waiting for the next `terminal:output` notification — otherwise
    // a late-mounting consumer would reproduce the exact "banner already passed" gap this
    // task exists to close.
    sync();
    const unsubscribe = tap.subscribe(sync);
    // Do not dispose `tap` here — it is owned by <CellBusProvider> and shared with other
    // consumers (e.g. useMcpFleetPush) that may still be mounted after this one unmounts.
    return unsubscribe;
  }, [tap]);
}
