import type { PermissionPrompt } from "../../../types/index.js";
import { parsePermissionPrompt } from "../permission/prompt.js";
import type { DropPayload } from "./payload.js";

/**
 * What the hooks say about each cell, and the rule for believing it.
 *
 * **ADR-8: two independent signals must agree.** The hook says a cell is waiting; the terminal
 * says what it is waiting for. A chip is drawn only when both do — and the digits come from the
 * terminal, never from here, because a hook knows that a prompt happened and not what it offered.
 *
 * Why that is not belt-and-braces. The hook fires and the prompt is drawn at slightly different
 * moments, and each failure alone is quiet:
 *
 * - Hook without terminal: the prompt scrolled away, or the agent already moved on. Trusting it
 *   would draw chips over a cell that is busy, and answering sends a digit into running work.
 * - Terminal without hook: past output. A tail holds old prompts, and `parsePermissionPrompt`
 *   deliberately reads the LAST one — which may have been answered ten minutes ago.
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
 * The latest hook status per pane.
 *
 * Correlation is by `paneId` and nothing else. The schema calls `cwd` the correlation key, and on
 * a desktop — one window, one pane per directory — that holds. Here several cells routinely share
 * one project, so falling back to cwd would hand one cell's approval to another. A drop with no
 * pane id is dropped rather than guessed at (slice 1b.1 is what puts it there).
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
 * Whether a cell is waiting, and what it is offering — from the two signals, separately.
 *
 * The two are not one verdict, and `PermissionResponse` is explicit about it: **`awaiting: true`
 * with a null prompt means "waiting, but the options could not be read"**, which a client renders
 * as a pointer to the terminal rather than as nothing. Collapsing that into `awaiting: false`
 * would hide a cell that really is stuck.
 *
 * What fails closed is the **prompt**, not the fact of waiting. A digit is only ever offered when
 * the terminal was read successfully, because a wrong digit approves the thing the operator meant
 * to refuse (ADR-8) — while a missing chip costs one trip to the raw terminal.
 *
 * And a prompt with no hook behind it is history: the tail holds old prompts, and
 * `parsePermissionPrompt` deliberately reads the LAST one, which may have been answered ten
 * minutes ago.
 */
export function awaitingPermission(
  turn: HookTurn | undefined,
  terminalTail: string,
  columns?: number,
): AwaitingPermission {
  if (turn?.status !== "needs-input") return { awaiting: false, prompt: null };
  return { awaiting: true, prompt: parsePermissionPrompt(terminalTail, columns) ?? null };
}
