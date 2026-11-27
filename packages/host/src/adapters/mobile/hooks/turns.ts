import type { PermissionPrompt } from "../../../types/index.js";
import { parsePermissionPrompt } from "../permission/prompt.js";
import type { DropPayload } from "./payload.js";

/**
 * **ADR-8: two independent signals must agree.** The hook says a cell waits; the terminal says
 * for what (digits come only from it). Hook alone: the prompt may be gone and a digit would hit
 * running work. Terminal alone: the tail holds old, answered prompts.
 */

/** How long a `needs-input` is believed without being renewed. */
export const TURN_TTL_MS = 30 * 60 * 1000;

export interface HookTurn {
  status: string;
  at: number;
  /** What the hook itself said, kept so a caller can say who is asking. */
  agentType: string;
}

/**
 * Latest hook status per pane, by `paneId` only: a cwd fallback would hand one cell's approval
 * to another. A drop with no pane id is dropped (slice 1b.1).
 */
export class HookTurns {
  private readonly turns = new Map<string, HookTurn>();

  constructor(private readonly now: () => number = Date.now) {}

  record(payload: DropPayload): boolean {
    if (payload.paneId === null) return false;
    this.turns.set(payload.paneId, {
      status: payload.status,
      at: payload.timestamp > 0 ? payload.timestamp : this.now(),
      agentType: payload.agentType,
    });
    return true;
  }

  /**
   * The shell hook's way in (`POST /v1/hook/turn`), which carries only what a `curl` can: the
   * pane, a status, a time. The drop-file producer uses `record` and brings the rest.
   */
  recordTurn(paneId: string, status: string, atMs: number): void {
    this.turns.set(paneId, { status, at: atMs, agentType: "" });
  }

  /** The last thing a pane's hooks said, or undefined once it has aged out. */
  statusOf(paneId: string): HookTurn | undefined {
    const turn = this.turns.get(paneId);
    if (turn === undefined) return undefined;
    // Aged out rather than deleted on read: a host that never polls a quiet pane would keep it
    // forever, and a `needs-input` from this morning is not a question anybody is still holding.
    if (this.now() - turn.at > TURN_TTL_MS) {
      this.turns.delete(paneId);
      return undefined;
    }
    return turn;
  }

  /** Panes this map still holds anything for. Bounded by `forget`, below. */
  size(): number {
    return this.turns.size;
  }

  /** Drops a pane's turn — called when its cell closes, so a closed cell asks nothing. */
  forget(paneId: string): void {
    this.turns.delete(paneId);
  }
}

export interface AwaitingPermission {
  awaiting: boolean;
  prompt: PermissionPrompt | null;
}

/**
 * **`awaiting: true` with a null prompt means "waiting, options unreadable"**; folding it into
 * `awaiting: false` would hide a stuck cell. The **prompt** fails closed (a wrong digit
 * approves what was meant to be refused, ADR-8), and a prompt with no hook is history.
 */
export function awaitingPermission(
  turn: HookTurn | undefined,
  terminalTail: string,
  columns?: number,
): AwaitingPermission {
  if (turn?.status !== "needs-input") return { awaiting: false, prompt: null };
  return { awaiting: true, prompt: parsePermissionPrompt(terminalTail, columns) ?? null };
}
