"use client";

import { useEffect, useRef } from "react";
import type { Node } from "@xyflow/react";
import { bridgeResolveMcpRequest } from "@/lib/tauri-api";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { agentStatusRegistry } from "../services/agent-status-registry";
import { resolveCanvasControlTarget } from "../services/canvas-control-target";
import { getCanvasBehaviorSettings } from "./useCanvasBehaviorSettings";

/**
 * Agent canvas-control bridge — lets agents driving the canvas (via the MCP tools
 * `lotus_focus_cell` / `lotus_arrange_canvas`) pan/zoom to a node or auto-arrange
 * the board. Rust (`/v1/canvas-control`) emits `mcp://canvas-control` with a
 * requestId; we honour it ONLY when the user has enabled "Let agents move the
 * canvas & focus" (Settings → Canvas, off by default), then resolve the pending
 * Rust request with a receipt. The user's own mouse/voice control never routes
 * through here, so it is never affected.
 *
 * Mount once inside CanvasPage. No-op outside Tauri.
 */
interface CanvasControlPayload {
  requestId: string;
  action: "focus" | "arrange";
  target?: string;
}

interface UseMcpCanvasControlBridgeOptions {
  nodes: Node[];
  focusNode: (nodeId: string) => void;
  arrangeNodes: () => void;
}

const EVENT = "mcp://canvas-control";

export function useMcpCanvasControlBridge({ nodes, focusNode, arrangeNodes }: UseMcpCanvasControlBridgeOptions): void {
  // The listener mounts once; read live nodes/callbacks through refs so a request
  // always resolves against the current board without re-subscribing.
  const depsRef = useRef({ nodes, focusNode, arrangeNodes });
  depsRef.current = { nodes, focusNode, arrangeNodes };

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const next = await listen<CanvasControlPayload>(EVENT, async (event) => {
        const payload = event.payload;
        if (!payload?.requestId) return;
        try {
          if (!getCanvasBehaviorSettings().allowAgentCanvasControl) {
            await bridgeResolveMcpRequest({
              requestId: payload.requestId,
              ok: false,
              error: "Agent canvas control is disabled by the user (Settings → Canvas → Let agents move the canvas & focus).",
            });
            return;
          }

          const { nodes: liveNodes, focusNode: focus, arrangeNodes: arrange } = depsRef.current;

          if (payload.action === "arrange") {
            arrange();
            await bridgeResolveMcpRequest({ requestId: payload.requestId, ok: true, data: { action: "arrange" } });
            return;
          }

          if (payload.action === "focus") {
            const resolution = resolveCanvasControlTarget(payload.target ?? "", liveNodes, agentStatusRegistry.list());
            if (!resolution.ok) {
              await bridgeResolveMcpRequest({ requestId: payload.requestId, ok: false, error: resolution.error });
              return;
            }
            focus(resolution.nodeId!);
            await bridgeResolveMcpRequest({
              requestId: payload.requestId,
              ok: true,
              data: { action: "focus", nodeId: resolution.nodeId },
            });
            return;
          }

          await bridgeResolveMcpRequest({
            requestId: payload.requestId,
            ok: false,
            error: `Unknown canvas-control action "${String((payload as { action?: unknown }).action)}".`,
          });
        } catch (err) {
          await bridgeResolveMcpRequest({
            requestId: payload.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
