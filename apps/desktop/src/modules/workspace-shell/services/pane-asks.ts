/**
 * What each waiting agent asked, by pane id, for the Needs you row's second line (GLOSSARY).
 *
 * Only the full `lotus://agent-hook` drop carries the question (`body`); the pane-turn event the
 * shell's activity reads does not. A remote hook sends no body, so an SSH pane has no entry.
 */
import { subscribeAgentHookEvents, type AgentHookSubscriber } from "@/modules/codecanvas/services/narration/use-narration-channel";
import type { AgentHookDropPayload } from "@/modules/codecanvas/services/narration/narration-event";

const asks = new Map<string, string>();
let stop: (() => void) | null = null;

/** One drop: a `needs-input` with text sets the pane's question; any other status clears it. */
export function notePaneAsk(drop: Pick<AgentHookDropPayload, "paneId" | "status" | "body">): void {
  if (!drop.paneId) return;
  const body = drop.body?.trim();
  if (drop.status === "needs-input" && body) asks.set(drop.paneId, body);
  else if (drop.status !== "needs-input") asks.delete(drop.paneId);
}

/** Starts listening once per window; later calls are no-ops. */
export function startPaneAsks(subscribe: AgentHookSubscriber = subscribeAgentHookEvents): () => void {
  stop ??= subscribe(notePaneAsk);
  return () => {
    stop?.();
    stop = null;
  };
}

export function paneAsks(): ReadonlyMap<string, string> {
  return asks;
}

/** Tests only. */
export function resetPaneAsksForTest(): void {
  asks.clear();
  stop = null;
}
