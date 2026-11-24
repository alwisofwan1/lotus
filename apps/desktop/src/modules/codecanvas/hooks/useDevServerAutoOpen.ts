"use client";
import { useEffect, useRef } from "react";
import type { Edge, Node } from "@xyflow/react";
import { navigateCanvasBrowser } from "@/lib/tauri/canvas-browser";
import {
  peekTerminalTranscript,
  tapTerminalOutput,
} from "@/modules/codespace/services/terminal-session-registry";
import { detectDevServerUrl } from "../services/dev-server-url-detect";
import { handleCanvasBrowserApiEvent } from "../services/canvas-browser-api-bridge";

interface UseDevServerAutoOpenOptions {
  nodes: Node[];
  edges: Edge[];
  spawnBrowserNode: (parentTerminalId: string, url: string) => string;
  patchNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  /** Gate from the `autoOpenBrowserOnDevServer` behaviour setting. */
  enabled: boolean;
}

/** Cap the per-pane rolling buffer so a URL split across PTY chunks is still matched. */
const MAX_BUFFER = 4096;

/**
 * Session-scoped guard so we auto-open a browser at most once per (terminal, origin) — a dev server
 * reprinting its banner on HMR must not spawn a second node. Module-level (survives node remounts),
 * like the occlusion store.
 */
const openedKeys = new Set<string>();

function originKey(nodeId: string, url: string): string {
  try {
    return `${nodeId}|${new URL(url).origin}`;
  } catch {
    return `${nodeId}|${url}`;
  }
}

/** paneId mirrors TerminalNode's `effectivePaneId = runtimePaneId ?? id`. */
function paneIdOf(node: Node): string {
  const runtimePaneId = (node.data as { runtimePaneId?: string } | undefined)?.runtimePaneId;
  return runtimePaneId ?? node.id;
}

/**
 * W1 — auto-open a Browser Node when a canvas Terminal's dev server prints its localhost URL. Taps
 * each terminal pane's output (plus its existing transcript, to catch a URL printed before we
 * attached), detects the ready URL, and routes an "open" through the SAME bridge handler an agent
 * uses — so it spawns a paired browser, or navigates the existing one. Mirrors the iOS Simulator
 * pane opening itself when the app runs.
 */
export function useDevServerAutoOpen({
  nodes,
  edges,
  spawnBrowserNode,
  patchNodeData,
  enabled,
}: UseDevServerAutoOpenOptions) {
  const graphRef = useRef({ nodes, edges });
  useEffect(() => {
    graphRef.current = { nodes, edges };
  }, [nodes, edges]);

  // Re-subscribe only when the set of terminal panes changes (not on every node move/patch).
  const paneKey = nodes
    .filter((node) => node.type === "terminal")
    .map((node) => `${node.id}:${paneIdOf(node)}`)
    .sort()
    .join(",");

  useEffect(() => {
    if (!enabled) return;
    const buffers = new Map<string, string>();
    const detachers: Array<() => void> = [];

    const act = (nodeId: string, url: string) => {
      const key = originKey(nodeId, url);
      if (openedKeys.has(key)) return;
      openedKeys.add(key);
      void handleCanvasBrowserApiEvent(
        { kind: "open", terminalId: nodeId, url },
        {
          nodes: graphRef.current.nodes,
          edges: graphRef.current.edges,
          spawnBrowserNode,
          patchNodeData,
          navigateBrowser: navigateCanvasBrowser,
        },
      ).catch((err: unknown) => console.warn("[dev-server-auto-open] open failed", err));
    };

    for (const node of graphRef.current.nodes.filter((n) => n.type === "terminal")) {
      const nodeId = node.id;
      const paneId = paneIdOf(node);

      // Seed with the pane's existing transcript so a URL already printed (dev server started before
      // the canvas mounted / this effect ran) is still caught, then keep the rolling tail.
      const seed = peekTerminalTranscript(paneId) ?? "";
      buffers.set(paneId, seed.length > MAX_BUFFER ? seed.slice(seed.length - MAX_BUFFER) : seed);
      const seedHit = detectDevServerUrl(buffers.get(paneId) ?? "");
      if (seedHit) act(nodeId, seedHit.url);

      const detach = tapTerminalOutput(paneId, (data) => {
        const combined = (buffers.get(paneId) ?? "") + data;
        const tail = combined.length > MAX_BUFFER ? combined.slice(combined.length - MAX_BUFFER) : combined;
        buffers.set(paneId, tail);
        const hit = detectDevServerUrl(tail);
        if (hit) act(nodeId, hit.url);
      });
      detachers.push(detach);
    }

    return () => {
      detachers.forEach((detach) => detach());
    };
    // graphRef is read live inside; only re-run when the pane set or gates change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, paneKey, spawnBrowserNode, patchNodeData]);
}

/** Test-only: reset the session-scoped auto-open guard. */
export function __resetDevServerAutoOpenGuard(): void {
  openedKeys.clear();
}
