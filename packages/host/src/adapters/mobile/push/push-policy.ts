import type { FleetMember } from "../../../types/fleet.js";
import type { NotificationEvent } from "../../../types/notifications.js";
import type { PushMessage, WakeKind } from "./fcm-sender.js";

/** The turn state this product exists to surface (job stories #1 and #2). */
const NEEDS_INPUT = "needs-input";

/**
 * Panes asked something **from a phone**: only those finishes wake it (`issues/04`). The finish
 * consumes the mark, so a desk-side follow-up stays quiet. `endsWith` because spawn answers
 * with the bare pane uuid while hook events carry a prefixed id.
 */
export class AskLedger {
  private readonly panes = new Set<string>();

  record(paneId: string): void {
    if (paneId.length > 0) this.panes.add(paneId);
  }

  /** True when this pane was asked from a phone; forgets it, so one ask earns one finish. */
  consume(paneId: string): boolean {
    for (const asked of this.panes) {
      if (paneId === asked || paneId.endsWith(asked)) {
        this.panes.delete(asked);
        return true;
      }
    }
    return false;
  }
}

/**
 * Only an agent **waiting for a human** or one that **finished a phone ask**. Not `agent_stop`
 * in general (every hook event is that variant: a ring per tool call); `cell_stalled` stays
 * out, as silence cannot be interpreted (`MVP.md` §2).
 */
export function wakeKindFor(event: NotificationEvent, asked: AskLedger): WakeKind | null {
  if (event.kind !== "agent_stop") return null;
  if (event.status === NEEDS_INPUT) return "attention";
  if (event.event === "stop" && event.pane_id !== undefined && asked.consume(event.pane_id)) {
    return "finished";
  }
  return null;
}

/**
 * The words a wake-up carries: the agent's name and one sentence from the app's own
 * vocabulary (`needs you` is what the Agent header says, in the one warm colour).
 * Never the prompt, the command, or a path — `issues/04`, content rule.
 */
export function composeMessage(
  kind: WakeKind,
  paneId: string,
  fleet: readonly FleetMember[],
  status: string,
): PushMessage {
  const cell = fleet.find((c) => c.paneId === paneId || paneId.endsWith(c.paneId));
  const title = cell?.title?.trim() || cell?.runnerLabel || "An agent";
  const body =
    kind === "attention" ? "needs you" : status === "error" ? "stopped with an error" : "finished";
  return { kind, title, body, paneId };
}
