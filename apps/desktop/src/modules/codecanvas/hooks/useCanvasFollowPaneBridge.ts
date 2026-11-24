"use client";

import { useEffect, useRef } from "react";

import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { projectIdFromCanvasPaneId } from "../services/canvas-runtime-scope";

/**
 * Brings the board on screen to the project of a pane a remote operator just spoke to.
 *
 * **Why a signal exists at all.** Dispatch never touches the frontend: Rust resolves the
 * pane to its PTY session and writes, which is exactly why a prompt from the phone reaches
 * an agent whose project is not open. The message arrives, the desktop stays put, and the
 * operator watches the wrong board — the half of the report that the spawn fix did not
 * cover, because spawn had somewhere the request *had* to land and dispatch does not.
 *
 * **Why it is safe to follow here.** Rust emits this only from `/api/fleet/dispatch`, the
 * remote-operator route. Agent-to-agent traffic uses the MCP server's own endpoint and is
 * deliberately not followed — a swarm dispatches constantly, and tracking that would leave
 * the board thrashing.
 *
 * Silent when the pane is already on the visible board, or when its id names no project.
 */
export interface CanvasFollowPaneDeps {
  activeProjectId: string | null;
  /** Every project this window can open; a pane from anywhere else is left alone. */
  knownProjectIds: readonly string[];
  switchToProject: (projectId: string) => void;
}

const FOLLOW_EVENT = "mcp://follow-pane";

/**
 * Which project the board should switch to for this pane, or `null` to stay put.
 *
 * Pulled out of the listener so the three ways this correctly does nothing are testable
 * without a Tauri event: the pane is already on screen, its id names no project, or the
 * project is one this window cannot open.
 */
export function projectToFollow(
  paneId: string | null | undefined,
  activeProjectId: string | null,
  knownProjectIds: readonly string[],
): string | null {
  const projectId = projectIdFromCanvasPaneId(paneId);
  if (projectId === null || projectId === activeProjectId) return null;
  // Not an error worth surfacing: the dispatch already succeeded, and the operator asked
  // for a prompt to land, not for a board to move.
  if (!knownProjectIds.includes(projectId)) return null;
  return projectId;
}

export function useCanvasFollowPaneBridge(deps: CanvasFollowPaneDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const next = await listen<{ paneId?: string | null }>(FOLLOW_EVENT, (event) => {
        const d = depsRef.current;
        const projectId = projectToFollow(event.payload?.paneId, d.activeProjectId, d.knownProjectIds);
        if (projectId !== null) d.switchToProject(projectId);
      });
      if (disposed) {
        safeTauriUnlisten(next);
        return;
      }
      unlisten = next;
    })();

    return () => {
      disposed = true;
      safeTauriUnlisten(unlisten);
    };
  }, []);
}
