import type { FleetMember } from "../../../types/fleet.js";
import type { NotificationEvent } from "../../../types/notifications.js";
import type { PushMessage, WakeKind } from "./fcm-sender.js";

/** The turn state this product exists to surface (job stories #1 and #2). */
const NEEDS_INPUT = "needs-input";

/**
 * Remembers which panes were asked something **from a phone**.
 *
 * The rule from `issues/04`: an agent finishing is worth a wake-up only when the ask
 * came from the phone — an agent the operator started at the desk finishing is not
 * news to a phone in their pocket. So the two mobile routes that send an ask
 * (`/m/cells` with a prompt, `/m/cell/:id/dispatch`) record it here, and the finish
 * consumes it, so a later desk-side follow-up on the same pane stays quiet.
 *
 * `endsWith` rather than equality because the spawn route answers with the bare pane
 * uuid while the desktop's hook events carry the same id — matched loosely once so
 * neither side has to learn the other's prefixing.
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
 * Which events are worth waking a phone for.
 *
 * Two, and only two: an agent that **stopped and is waiting for a human**, and an
 * agent that **finished an ask the phone sent**. Not `agent_stop` in general — every
 * hook event arrives as that same variant, including `tool-pre` and `session-start`,
 * both `status: "running"`; waking on those would be a notification per tool call.
 *
 * `cell_stalled` stays out: a stalled cell may be an agent thinking hard, and silence
 * from a runner that reports no turn cannot be interpreted (`MVP.md` §2). Pushing
 * "possibly stuck" trains the operator to ignore the channel.
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
