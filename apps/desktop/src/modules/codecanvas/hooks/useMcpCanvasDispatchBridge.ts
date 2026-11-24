"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Node } from "@xyflow/react";
import { bridgeResolveMcpRequest } from "@/lib/tauri-api";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { agentStatusRegistry } from "../services/agent-status-registry";
import type { CanvasFleetAgentNodeRef } from "../services/canvas-fleet";
import {
  createAgentMessagingDeps,
  resolveCanvasDispatchTarget,
} from "../services/canvas-agent-messaging";
import {
  agentDeliveryQueue,
  deliverToAgent,
  deliveryReceipt,
  wireDeliveryQueueFlush,
} from "../services/canvas-agent-delivery";
import { nodeIdFromPaneId } from "../services/canvas-spawn-depth";
import { formatPeerMessage, resolveAgentDisplayName } from "../services/canvas-peer-message";
import type { CanvasAgentNodeData } from "../types/canvas";

/**
 * ADR-0030 — canvas agent→agent delivery bridge. The MCP `lotus_dispatch_to_cell` tool, when the
 * target is a `canvas:` member, round-trips here (Rust emits `mcp://dispatch-to-canvas-agent`)
 * instead of writing to a PTY session that canvas live agents don't expose. We resolve the target
 * by name/id against the live roster + visible nodes, then hand off to the canonical delivery layer
 * (`deliverToAgent` → session resume, with a TTL queue for still-spawning agents) and resolve the
 * pending Rust request with an actionable {@link deliveryReceipt} so the calling agent learns whether
 * the message was delivered, queued ("Nova is starting; message queued"), or skipped — never a
 * silent 404. Queued messages flush automatically when the target's status flips to ready
 * (wireDeliveryQueueFlush, mounted below).
 *
 * Mount once inside CanvasPage. The dispatch listener is Tauri-only; the flush wiring runs everywhere.
 */
type CanvasDispatchPayload = {
  requestId: string;
  target: string;
  text: string;
  /** Pane id of the agent that sent it; absent when a human dispatched. */
  fromPaneId?: string | null;
};

const EVENT = "mcp://dispatch-to-canvas-agent";

/**
 * Agent nodes only — and that is the whole reason a Canvas **Terminal** node is invisible to
 * every remote client.
 *
 * Traced in `plans/session-history-hardening/issues/06` after three measurement runs failed
 * against a Terminal node and were each misdiagnosed as something else. The chain is:
 * this filter → `pushCanvasFleet` → `/api/fleet` → `/m/bootstrap` → Pocket's cell list. A
 * terminal node is dropped here, at the first step, so it never reaches any of them — and
 * `/api/fleet/scrollback` refuses a pane that is not in the snapshot, which is why bytes
 * pushed through such a pane can never be read remotely.
 *
 * That makes it unreachable rather than broken: Pocket cannot show a blank terminal for a
 * node it was never told about. CodeSpace publishes all of its cells including plain
 * shells (`useMcpFleetPush`), so the two surfaces deliberately differ — if Canvas terminals
 * should be watchable from a phone, that is a feature decision, not a bug fix.
 */
function agentRefsFromNodes(nodes: readonly Node[]): CanvasFleetAgentNodeRef[] {
  return nodes
    .filter((node) => node.type === "agent")
    .map((node) => {
      const data = node.data as Partial<CanvasAgentNodeData> | undefined;
      return {
        id: node.id,
        name: typeof data?.name === "string" && data.name.trim() ? data.name : node.id,
        runner: data?.runner,
        runnerCommand: typeof data?.runnerCommand === "string" ? data.runnerCommand : undefined,
        projectId: typeof data?.projectId === "string" ? data.projectId : null,
      };
    });
}

export function useMcpCanvasDispatchBridge(nodes: readonly Node[] = []): void {
  const visibleAgents = useMemo(() => agentRefsFromNodes(nodes), [nodes]);
  const visibleAgentsRef = useRef<CanvasFleetAgentNodeRef[]>(visibleAgents);
  visibleAgentsRef.current = visibleAgents;

  // Flush TTL-buffered dispatches when a target agent's status flips to ready. A message dispatched
  // to a still-spawning agent is buffered (deliverToAgent → agent-starting) rather than 404'd; this
  // subscription drains that buffer the moment the agent can receive it. Runs everywhere (not just
  // Tauri) so the same behavior holds in tests/browser dev.
  useEffect(() => wireDeliveryQueueFlush(agentDeliveryQueue, agentStatusRegistry, createAgentMessagingDeps()), []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const next = await listen<CanvasDispatchPayload>(EVENT, async (event) => {
        const payload = event.payload;
        if (!payload?.requestId) return;
        try {
          const roster = agentStatusRegistry.list();
          const resolution = resolveCanvasDispatchTarget(payload.target ?? "", roster, visibleAgentsRef.current);
          if (!resolution.ok) {
            console.debug("[canvas-dispatch] target unresolved", { target: payload.target, error: resolution.error });
            await bridgeResolveMcpRequest({ requestId: payload.requestId, ok: false, error: resolution.error });
            return;
          }
          const displayName = resolveAgentDisplayName(resolution.id, roster, visibleAgentsRef.current) ?? resolution.id;
          // A peer message arrives attributed; a human dispatch stays bare. Resolved against the
          // same roster as the target, so the sender is named the way the board names it.
          const senderName = resolveAgentDisplayName(
            nodeIdFromPaneId(payload.fromPaneId), roster, visibleAgentsRef.current,
          );
          const text = formatPeerMessage(payload.text ?? "", senderName);
          const outcome = deliverToAgent(resolution.id, text, createAgentMessagingDeps(), agentDeliveryQueue);
          const receipt = deliveryReceipt(resolution.id, displayName, outcome);
          console.debug("[canvas-dispatch] delivered", { target: payload.target, id: resolution.id, receipt });
          await bridgeResolveMcpRequest({ requestId: payload.requestId, ok: true, data: receipt });
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
