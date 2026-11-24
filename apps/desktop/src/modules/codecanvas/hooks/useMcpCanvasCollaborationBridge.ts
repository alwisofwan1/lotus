"use client";

import { useEffect, useRef } from "react";
import type { BridgeTask } from "@/lib/tauri-api";
import { bridgeResolveMcpRequest } from "@/lib/tauri-api";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import type { CanvasCollaborationLaunch } from "../services/canvas-collaboration-launch";
import type { AppendCanvasCollaborationMessageInput, CanvasCollaborationMailboxMessage } from "../services/collaboration/canvas-collaboration-mailbox";
import { planCanvasCollaborationMcpRequest, type CanvasCollaborationMcpRequest } from "../services/collaboration/canvas-collaboration-mcp";
import type { CanvasCollaborationParticipantView } from "../services/collaboration/canvas-collaboration-participants";

const EVENT = "mcp://canvas-collaboration";

export interface UseMcpCanvasCollaborationBridgeOptions {
  launch: CanvasCollaborationLaunch;
  participants: CanvasCollaborationParticipantView[];
  task?: BridgeTask | null;
  mailboxMessages: CanvasCollaborationMailboxMessage[];
  appendMessage: (input: AppendCanvasCollaborationMessageInput) => void;
}

/**
 * Frontend-mediated MCP bridge for the optional CodeCanvas collaboration ledger.
 * The durable ledger/mailbox is currently browser-owned, so Rust validates the
 * tool request then emits this event to the Canvas UI that owns localStorage.
 */
export function useMcpCanvasCollaborationBridge(options: UseMcpCanvasCollaborationBridgeOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const next = await listen<CanvasCollaborationMcpRequest>(EVENT, async (event) => {
        const payload = event.payload;
        if (!payload?.requestId) return;
        try {
          const live = optionsRef.current;
          const plan = planCanvasCollaborationMcpRequest(payload, {
            launch: live.launch,
            participants: live.participants,
            task: live.task,
            mailboxMessages: live.mailboxMessages,
          });
          if (!plan.ok) {
            await bridgeResolveMcpRequest({ requestId: payload.requestId, ok: false, error: plan.error });
            return;
          }
          if (plan.appendMessage) live.appendMessage(plan.appendMessage);
          await bridgeResolveMcpRequest({ requestId: payload.requestId, ok: true, data: plan.data });
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
