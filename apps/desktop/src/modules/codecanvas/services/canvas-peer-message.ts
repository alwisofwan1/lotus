/**
 * Sender attribution for agent→agent messages on the canvas.
 *
 * A canvas agent is a CLI inside a PTY: the only thing it ever sees is the text written to it. So
 * an unattributed peer message is indistinguishable from the user typing — the receiver cannot tell
 * who asked, and has no way to answer. Claude Code solves the same problem by wrapping inbound
 * cross-session messages as `<cross-session-message from="...">`; here the envelope has to live in
 * the text itself, because Lotus chrome is not something the CLI can read.
 *
 * A message with no sender is left exactly as it was: a human dispatch should not grow an envelope.
 */

import type { AgentStatusSnapshot } from "./agent-status-registry";
import type { CanvasFleetAgentNodeRef } from "./canvas-fleet";

/**
 * Prefixes `text` with the sender, and only the sender.
 *
 * How to answer is deliberately NOT repeated here: the dispatcher's own `replyTo` envelope already
 * carries it, and only when the sender actually wants a reply. Saying it in both places cost every
 * peer message a duplicated paragraph — for a one-line request the envelope outweighed the request.
 */
export function formatPeerMessage(text: string, from: string | null | undefined): string {
  const sender = from?.trim();
  if (!sender || !text.trim()) return text;
  return `[from @${sender}]\n${text}`;
}

/**
 * The human-facing name of a canvas agent node. The live roster wins; a visible node covers the
 * window where a node exists on the board but its runtime entry has not published yet (the same
 * gap `projectCanvasAgentStatusSnapshots` closes for the fleet). Falls back to the node id, which
 * is at least addressable.
 */
export function resolveAgentDisplayName(
  nodeId: string | null | undefined,
  roster: readonly Pick<AgentStatusSnapshot, "id" | "name">[],
  visibleAgents: readonly Pick<CanvasFleetAgentNodeRef, "id" | "name">[] = [],
): string | null {
  if (!nodeId) return null;
  return roster.find((a) => a.id === nodeId)?.name
    ?? visibleAgents.find((a) => a.id === nodeId)?.name
    ?? nodeId;
}
