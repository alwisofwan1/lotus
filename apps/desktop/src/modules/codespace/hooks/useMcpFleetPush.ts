"use client";

import { useEffect, useRef } from "react";
import { bridgePushFleetSnapshot, type McpFleetMemberPayload } from "@/lib/tauri-api";
import { deriveFleet } from "@/modules/codespace/services/bridge/fleet-derivation";
import { useCellBusEvent, useCellOutputTap } from "@/modules/codespace/services/bridge/cell-bus-context";
import { getAllTerminalSessions } from "@/modules/codespace/services/terminal-session-registry";
import { useFleetSettings } from "@/modules/codespace/hooks/useFleetSettings";
import type { Workspace } from "@/modules/codespace/components/types";

export function createMcpFleetSnapshotSignature(members: readonly McpFleetMemberPayload[]): string {
  return JSON.stringify(members);
}

/**
 * What a human calls this workspace — the last segment of its cwd.
 *
 * Omitted rather than sent blank: `workspace_label` is an `Option<String>` on the Rust side and
 * an absent one reads as "this host cannot name the project", which a client can fall back from.
 * An empty string would be a name, and a blank one. Same rule `canvas-fleet.ts` already follows.
 */
export function workspaceLabelFromCwd(cwd: string | undefined): string | undefined {
  // Takes `string | undefined` even though `Workspace.cwd` is declared required: workspaces are
  // restored from persisted JSON across schema versions, and this runs inside `flush()`, which
  // nothing wraps in a try/catch. A `cwd.trim()` on a missing field would throw before the push
  // call is ever made, taking the ENTIRE fleet snapshot down — every cell, every workspace — for
  // one unnamed project.
  const trimmed = typeof cwd === "string" ? cwd.trim().replace(/[/\\]+$/, "") : "";
  if (!trimmed) return undefined;
  return trimmed.split(/[/\\]/).pop()?.trim() || undefined;
}

/**
 * Aliases worth publishing — a generic provider label is dropped.
 *
 * "Claude" is not a distinguishing alias when five cells are all called Claude: publishing it
 * would widen exactly the ambiguity a readable address exists to remove. A name a human actually
 * gave (the Agent Handle, `agentName`) does distinguish, so it stays.
 */
export function publishableAliases(member: {
  aliases?: readonly string[];
  displayName: string;
  agentName?: string;
}): string[] {
  const generic = member.agentName?.trim() ? null : member.displayName;
  return (member.aliases ?? []).filter((alias) => alias !== generic);
}

/**
 * Pushes a snapshot of every workspace's fleet to the Rust-side MCP state so
 * the MCP sidecar's `lotus_list_fleet` tool can answer Claude.
 *
 * Output-bursts are coalesced via a debounce (settings-controlled,
 * default 150ms). Spawn/exit events bypass the debounce and flush
 * immediately when `forceFleetSnapshotOnSpawn` is enabled,
 * so Claude sees new cells without racing on the debounce window.
 *
 * Dead cells (status === "exited") are skipped when
 * `includeExitedInFleet` is false (the default).
 *
 * Safe to mount at a high level (CodeSpacePage) — runs even when Bridge
 * pane is not visible. No-op outside Tauri.
 */
export function useMcpFleetPush(
  workspaces: readonly Workspace[],
  activeWorkspaceId?: string | null,
): void {
  // (07) Shared with useFleetIdentitySync via <CellBusProvider> — not created here anymore.
  // Do not dispose it: it's owned by the provider, and other consumers stay mounted after
  // this hook unmounts.
  const tap = useCellOutputTap();
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  // Read through a ref for the same reason `workspaces` is: `flush()` runs from a timer and from
  // bus events, long after the render that scheduled it.
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPushedSignatureRef = useRef<string | null>(null);
  const fleetSettings = useFleetSettings();
  const settingsRef = useRef(fleetSettings);
  settingsRef.current = fleetSettings;

  const flush = () => {
    pendingRef.current = null;
    const sessions = getAllTerminalSessions();
    const fleet = settingsRef.current.read();
    const members: McpFleetMemberPayload[] = [];
    for (const workspace of workspacesRef.current) {
      const derived = deriveFleet(workspace.cells, sessions, workspace.id, tap);
      const workspaceLabel = workspaceLabelFromCwd(workspace.cwd);
      for (const m of derived) {
        if (!fleet.includeExitedInFleet && !m.isAlive) continue;
        const aliases = publishableAliases(m);
        members.push({
          pane_id: m.paneId,
          // The readable half of a cell's identity. Rust has matched on `agent_address`
          // and `aliases` since RC-3, but this push never sent either, so the only
          // addressable name a codespace cell ever had was its pane UUID.
          ...(m.agentAddress ? { agent_address: m.agentAddress } : {}),
          ...(aliases.length ? { aliases } : {}),
          ...(m.legacyAgentAddresses?.length ? { legacy_aliases: m.legacyAgentAddresses } : {}),
          ...(workspaceLabel ? { workspace_label: workspaceLabel } : {}),
          workspace_id: m.workspaceId,
          cwd: m.cwd,
          provider: m.provider,
          runner_label: m.runnerLabel,
          display_name: m.displayName,
          // (Slice 02 §6) The conversation title, not the cell's name — it can be
          // regenerated at any time, so it travels as `headline`, never as `display_name`.
          // Only a `ready` title is trustworthy enough to publish; omit the key rather than
          // send a stale/placeholder string for `generating`/`failed`/`pending`.
          ...(m.titleStatus === "ready" && m.title ? { headline: m.title } : {}),
          status: m.status,
          is_alive: m.isAlive,
          // No `last_output_preview`: it changed on every output chunk and re-pushed the whole
          // fleet ~1.6/s (ipc.calls, 2026-11-15). Rust reads it from the PTY ring instead.
          session_id: m.sessionId ?? null,
        });
      }
    }
    const active = activeWorkspaceIdRef.current;
    // The active workspace is part of the signature: switching workspace often leaves the fleet
    // itself byte-identical (same cells, same statuses), and the de-dupe would then swallow the
    // push that moves the scope — leaving `list_fleet` answering for the workspace the operator
    // just left.
    const signature = `${active ?? ""}\u0000${createMcpFleetSnapshotSignature(members)}`;
    if (lastPushedSignatureRef.current === signature) return;
    lastPushedSignatureRef.current = signature;
    void bridgePushFleetSnapshot(members, active).catch(() => undefined);
  };

  const schedule = () => {
    if (pendingRef.current) return;
    const delay = settingsRef.current.read().fleetPushDebounceMs;
    pendingRef.current = setTimeout(flush, delay);
  };

  const forceFlush = () => {
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    flush();
  };

  const onCriticalFleetChange = () => {
    if (settingsRef.current.read().forceFleetSnapshotOnSpawn) {
      forceFlush();
    } else {
      schedule();
    }
  };

  useCellBusEvent("terminal:spawned", onCriticalFleetChange);
  useCellBusEvent("terminal:exited", onCriticalFleetChange);
  useCellBusEvent("terminal:status", onCriticalFleetChange);

  useEffect(() => {
    // (07) `tap` is owned by <CellBusProvider>, not by this hook — do not dispose it here.
    // Disposing would clear the buffers/provider map/switch window out from under
    // useFleetIdentitySync (or any other consumer) still mounted on the same shared tap.
    const unsub = tap.subscribe(schedule);
    return () => {
      unsub();
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tap]);

  useEffect(() => {
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, activeWorkspaceId]);
}
