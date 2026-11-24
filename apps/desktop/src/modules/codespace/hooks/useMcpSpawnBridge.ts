"use client";

import { useEffect, useRef } from "react";
import { bridgeResolveMcpRequest } from "@/lib/tauri-api";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { applyPermissionMode, type PermissionMode } from "@/lib/agent-runtime/agent-gating";
import { applyTuning } from "@/lib/agent-runtime/agent-tuning";
import { resolve as resolveAgentProvider } from "@/modules/codespace/services/bridge/agent-registry";
import { useCellBus } from "@/modules/codespace/services/bridge/cell-bus-context";
import { deliverInitialPrompt } from "@/modules/codespace/services/spawn-brief";
import { getTerminalRuntimeSessionId } from "@/modules/codespace/services/terminal-session-registry";
import type { ExecutorProviderId } from "@/modules/codespace/components/types";

type SpawnPayload = {
  requestId: string;
  provider: string;
  workspaceId?: string | null;
  /** Phase C: first task auto-submitted once the cell is live (spawn-with-brief). */
  initialPrompt?: string | null;
  /** Phase C: runner/CLI id override; defaults to `provider`. */
  runnerId?: string | null;
  cwd?: string | null;
  role?: string | null;
  /**
   * Whether the new cell asks before acting. Absent keeps the runner's own default,
   * which is what every caller before the phone relied on.
   */
  permissionMode?: PermissionMode | null;
  /** `spawn-tuning`: the model alias and effort the phone chose. Absent = the CLI's defaults. */
  model?: string | null;
  effort?: string | null;
  /** Claude only: the account to run as (issues/07); validated by Rust before it gets here. */
  profileId?: string | null;
  /** The agent pane that asked (`LOTUS_PANE_ID`); absent for a human or the phone. */
  fromPaneId?: string | null;
};

const SPAWN_EVENT = "mcp://spawn-cell";
const SPAWN_WAIT_MS = 5000;
const SESSION_ID_POLL_MS = 50;
const MAX_SEEN_REQUEST_IDS = 200;
const seenSpawnRequestIds: string[] = [];
const seenSpawnRequestIdSet = new Set<string>();

export type SpawnDelegate = (agentCommand: string, workspaceId?: string, claudeAccount?: string, fromPaneId?: string) => string | null;

/**
 * Whether a pane runs its agent as the PTY's own process (true) or types it into a shell first
 * (false); undefined when the pane is not known. Decides which terminal handover the brief waits for.
 */
export type LaunchesDirectly = (paneId: string) => boolean | undefined;

type SpawnResult = {
  paneId: string;
  workspaceId?: string;
  cwd?: string;
  sessionId?: string | null;
};

/** The native spec for a token, falling back to the payload's provider, then to claude. */
function resolveNative(token: string, provider: string): { command: string[] } {
  try {
    return resolveAgentProvider(token as ExecutorProviderId);
  } catch {
    try {
      return resolveAgentProvider(provider as ExecutorProviderId);
    } catch {
      return resolveAgentProvider("claude" as ExecutorProviderId);
    }
  }
}

function markSpawnRequestSeen(requestId: string): boolean {
  if (seenSpawnRequestIdSet.has(requestId)) return false;
  seenSpawnRequestIdSet.add(requestId);
  seenSpawnRequestIds.push(requestId);
  while (seenSpawnRequestIds.length > MAX_SEEN_REQUEST_IDS) {
    const old = seenSpawnRequestIds.shift();
    if (old) seenSpawnRequestIdSet.delete(old);
  }
  return true;
}

/**
 * Subscribes to Rust-side `mcp://spawn-cell` events triggered by the MCP
 * sidecar's `lotus_spawn_cell` tool, emits the cross-cell bus request-spawn
 * event locally (which the existing {@link CellBusProvider} converts to a
 * real Terminal cell via `onRequestSpawn`), then resolves the pending Rust
 * request with the new paneId + PTY session id so the HTTP caller can return
 * only after follow-up tools like `lotus_wait_cell_idle` can resolve the pane.
 *
 * Usage: mount inside CodeSpacePage next to <McpFleetPusher/>.
 */
export function useMcpSpawnBridge(delegate: SpawnDelegate, launchesDirectly?: LaunchesDirectly): void {
  const bus = useCellBus();
  const delegateRef = useRef(delegate);
  delegateRef.current = delegate;
  const launchesDirectlyRef = useRef(launchesDirectly);
  launchesDirectlyRef.current = launchesDirectly;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const nextUnlisten = await listen<SpawnPayload>(SPAWN_EVENT, async (event) => {
        const payload = event.payload;
        if (!payload?.requestId || !payload.provider) return;
        if (!markSpawnRequestSeen(payload.requestId)) return;
        try {
          // runnerId overrides the provider when present (falls back if it isn't a known runner).
          const providerId = (payload.runnerId && payload.runnerId.trim()) || payload.provider;

          const baseCommand = resolveNative(providerId, payload.provider).command;

          // The one moment this can be decided: `--dangerously-skip-permissions` is a
          // process argument, so a cell already running cannot be turned back (ADR-8).
          const postured = payload.permissionMode
            ? applyPermissionMode(baseCommand, providerId, payload.permissionMode)
            : baseCommand;
          // Model and effort are process arguments too, so this is their one moment as well.
          const agentCommand = applyTuning(postured, providerId, {
            model: payload.model ?? undefined,
            effort: payload.effort ?? undefined,
          }).join(" ");
          const spawned = await awaitSpawn(
            bus,
            payload.workspaceId ?? undefined,
            payload.provider,
            () => {
              const account = payload.profileId?.trim() || undefined;
              const from = payload.fromPaneId?.trim() || undefined;
              const workspaceId = payload.workspaceId ?? undefined;
              if (from) return delegateRef.current(agentCommand, workspaceId, account, from);
              return account
                ? delegateRef.current(agentCommand, workspaceId, account)
                : delegateRef.current(agentCommand, workspaceId);
            },
          );
          await bridgeResolveMcpRequest({
            requestId: payload.requestId,
            ok: Boolean(spawned),
            data: spawned ? { ...spawned, provider: payload.provider } : undefined,
            error: spawned ? undefined : "spawn delegate returned no paneId",
          });
          // spawn-with-brief: once the cell exists, type + submit its first task (best-effort).
          // A pane whose launch is unknown is treated as shell-fronted: waiting too long is safe,
          // typing into a shell prompt is not.
          const brief = payload.initialPrompt?.trim();
          if (spawned?.paneId && brief) {
            const behindShell = launchesDirectlyRef.current?.(spawned.paneId) !== true;
            void deliverInitialPrompt(spawned.paneId, brief, { behindShell });
          }
        } catch (err) {
          await bridgeResolveMcpRequest({
            requestId: payload.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      if (disposed) {
        safeTauriUnlisten(nextUnlisten);
        return;
      }
      unlisten = nextUnlisten;
    })();

    return () => {
      disposed = true;
      safeTauriUnlisten(unlisten);
    };
  }, [bus]);
}

async function awaitSpawn(
  bus: ReturnType<typeof useCellBus>,
  expectedWorkspaceId: string | undefined,
  _provider: string,
  run: () => string | null,
): Promise<SpawnResult | null> {
  // Subscribe before invoking delegate so we don't miss the spawned event.
  return new Promise<SpawnResult | null>((resolvePromise) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setTimeout> | null = null;
    let prelimPaneId: string | null = null;
    let observed: Omit<SpawnResult, "sessionId"> | null = null;
    let resolved = false;
    let unsub: () => void = () => undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (poll) clearTimeout(poll);
      unsub();
    };

    const finish = (result: SpawnResult | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolvePromise(result);
    };

    const currentPaneId = () => observed?.paneId ?? prelimPaneId;
    const buildFallbackResult = (): SpawnResult | null => {
      const paneId = currentPaneId();
      if (!paneId) return null;
      return {
        paneId,
        workspaceId: observed?.workspaceId,
        cwd: observed?.cwd,
        sessionId: getTerminalRuntimeSessionId(paneId),
      };
    };

    const pollForSessionId = () => {
      if (resolved) return;
      const paneId = currentPaneId();
      if (!paneId) return;
      const sessionId = getTerminalRuntimeSessionId(paneId);
      if (sessionId) {
        finish({
          paneId,
          workspaceId: observed?.workspaceId,
          cwd: observed?.cwd,
          sessionId,
        });
        return;
      }
      if (!poll) {
        poll = setTimeout(() => {
          poll = null;
          pollForSessionId();
        }, SESSION_ID_POLL_MS);
      }
    };

    timeout = setTimeout(() => {
      finish(buildFallbackResult());
    }, SPAWN_WAIT_MS);

    unsub = bus.on("terminal:spawned", (payload) => {
      if (expectedWorkspaceId && payload.workspaceId !== expectedWorkspaceId) return;
      // Prefer the one that matches our invoked paneId.
      if (!prelimPaneId || prelimPaneId === payload.paneId) {
        observed = {
          paneId: payload.paneId,
          workspaceId: payload.workspaceId,
          cwd: payload.cwd,
        };
        pollForSessionId();
      }
    });
    try {
      prelimPaneId = run() ?? null;
      pollForSessionId();
    } catch {
      finish(null);
      return;
    }
  });
}
