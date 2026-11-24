"use client";
import { useEffect, useRef } from "react";
import type { Edge, Node } from "@xyflow/react";
import { navigateCanvasBrowser } from "@/lib/tauri/canvas-browser";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import {
  handleCanvasBrowserApiEvent,
  type CanvasBrowserApiEvent,
} from "../services/canvas-browser-api-bridge";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

interface UseCanvasBrowserApiBridgeOptions {
  nodes: Node[];
  edges: Edge[];
  spawnBrowserNode: (parentTerminalId: string, url: string) => string;
  patchNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
}

/**
 * Tauri event adapter for Canvas Browser API calls emitted by native/agent paths.
 * Keeps the page container free of listener lifecycle and stale-state refs.
 */
export function useCanvasBrowserApiBridge({
  nodes,
  edges,
  spawnBrowserNode,
  patchNodeData,
}: UseCanvasBrowserApiBridgeOptions) {
  const latestGraphRef = useRef({ nodes, edges });

  useEffect(() => {
    latestGraphRef.current = { nodes, edges };
  }, [nodes, edges]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlistenOpen: (() => void) | null = null;
    let unlistenNavigate: (() => void) | null = null;

    const handle = (event: CanvasBrowserApiEvent) => {
      const { nodes: latestNodes, edges: latestEdges } = latestGraphRef.current;
      void handleCanvasBrowserApiEvent(event, {
        nodes: latestNodes,
        edges: latestEdges,
        spawnBrowserNode,
        patchNodeData,
        navigateBrowser: navigateCanvasBrowser,
      }).catch((err: unknown) => console.warn("[canvas-browser-api] request failed", err));
    };

    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const open = await listen<{ terminalId?: string; url?: string; label?: string }>("canvas://browser-open", ({ payload }) => {
        if (payload?.terminalId && payload.url) {
          handle({
            kind: "open",
            terminalId: payload.terminalId,
            url: payload.url,
            label: payload.label,
          });
        }
      });
      const navigate = await listen<{ terminalId?: string; url?: string }>("canvas://browser-navigate", ({ payload }) => {
        if (payload?.terminalId && payload.url) handle({ kind: "navigate", terminalId: payload.terminalId, url: payload.url });
      });
      if (disposed) {
        safeTauriUnlisten(open);
        safeTauriUnlisten(navigate);
        return;
      }
      unlistenOpen = open;
      unlistenNavigate = navigate;
    })().catch((err: unknown) => {
      if (!disposed) console.warn("[canvas-browser-api] listener setup failed", err);
    });

    return () => {
      disposed = true;
      safeTauriUnlisten(unlistenOpen);
      safeTauriUnlisten(unlistenNavigate);
    };
  }, [patchNodeData, spawnBrowserNode]);
}
