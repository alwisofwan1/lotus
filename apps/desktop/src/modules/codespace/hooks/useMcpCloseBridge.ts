"use client";

import { useEffect, useRef } from "react";
import { bridgeResolveMcpRequest } from "@/lib/tauri-api";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

type ClosePayload = {
  requestId: string;
  paneId: string;
};

const CLOSE_EVENT = "mcp://close-cell";
const MAX_SEEN_REQUEST_IDS = 200;

const seenCloseRequestIds: string[] = [];
const seenCloseRequestIdSet = new Set<string>();

export type CloseDelegate = (paneId: string) => boolean;

function markCloseRequestSeen(requestId: string): boolean {
  if (seenCloseRequestIdSet.has(requestId)) return false;
  seenCloseRequestIdSet.add(requestId);
  seenCloseRequestIds.push(requestId);
  while (seenCloseRequestIds.length > MAX_SEEN_REQUEST_IDS) {
    const old = seenCloseRequestIds.shift();
    if (old) seenCloseRequestIdSet.delete(old);
  }
  return true;
}

/**
 * Subscribes to Rust-side `mcp://close-cell` events triggered by the MCP
 * sidecar's `lotus_close_cell` tool and resolves the pending Rust request
 * after asking the delegate to remove the pane.
 *
 * The delegate is expected to look up the pane's workspace and call the
 * workspace manager's `removePane`. Returning `false` surfaces a structured
 * error back to Claude via the tool result.
 *
 * Mount once inside CodeSpacePage next to `<McpSpawnBridge/>`.
 */
export function useMcpCloseBridge(delegate: CloseDelegate): void {
  const delegateRef = useRef(delegate);
  delegateRef.current = delegate;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const nextUnlisten = await listen<ClosePayload>(CLOSE_EVENT, async (event) => {
        const payload = event.payload;
        if (!payload?.requestId || !payload.paneId) return;
        if (!markCloseRequestSeen(payload.requestId)) return;
        try {
          const ok = delegateRef.current(payload.paneId);
          await bridgeResolveMcpRequest({
            requestId: payload.requestId,
            ok,
            data: ok ? { ok: true, paneId: payload.paneId } : undefined,
            error: ok ? undefined : `pane not found: ${payload.paneId}`,
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
        safeTauriUnlisten(nextUnlisten);
        return;
      }
      unlisten = nextUnlisten;
    })();

    return () => {
      disposed = true;
      safeTauriUnlisten(unlisten);
    };
  }, []);
}
