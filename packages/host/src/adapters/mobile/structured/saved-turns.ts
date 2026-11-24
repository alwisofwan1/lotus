import type { ConversationUpdate, ErrorPart, Part, Turn } from "../../../types/conversation.js";

export const CUT_OFF_MESSAGE = "Reply cut off by a host restart. It was not sent again.";

// shortcut: a fixed cap on history kept across restarts; page it from disk if 200 turns proves too few
const MAX_SAVED_TURNS = 200;

/** Earlier turns plus this run's. `live` is already named by `genTurns`. */
export function savedTurns(prior: Turn[], live: Turn[]): Turn[] {
  return [...prior, ...live].slice(-MAX_SAVED_TURNS);
}

/**
 * This run's turns named by `gen`, because a resumed runner numbers its turns from zero again.
 * Named the same way live, on the page and when saved, so a turn keeps one id across a restart:
 * a client that already drew `g:t-0` must not see it come back as a new turn.
 */
export function genTurns(turns: Turn[], gen: string): Turn[] {
  return turns.map((t) => ({ ...t, turnId: `${gen}:${t.turnId}`, parts: t.parts.map((p): Part => ({ ...p, id: `${gen}:${p.id}` })) }));
}

/** One live update named like `genTurns`. */
export function genUpdate(u: ConversationUpdate, gen: string): ConversationUpdate {
  if (u.kind === "turn") return { ...u, turn: { ...u.turn, turnId: `${gen}:${u.turn.turnId}` } };
  if (u.kind === "part") return { ...u, turnId: `${gen}:${u.turnId}`, part: { ...u.part, id: `${gen}:${u.part.id}` } };
  return { ...u, turnId: `${gen}:${u.turnId}`, partId: `${gen}:${u.partId}` };
}

/** A turn still open when the host went down was cut off. It is marked, never resent: it could run a command twice. */
export function closeCutTurn(turns: Turn[], now: number): Turn[] {
  const last = turns.at(-1);
  if (last === undefined || last.endedAt !== undefined) return turns;
  const marker = errorPart(`${last.turnId}-cut`, CUT_OFF_MESSAGE, true, now, last.parts.length);
  return [...turns.slice(0, -1), { ...last, endedAt: now, stopReason: "cancelled", parts: [...last.parts, marker] }];
}

/** Why a saved cell could not come back. Shown, so the cell does not just vanish. */
export function endedTurn(reason: string, now: number): Turn {
  const turnId = `ended-${now}`;
  const message = `This chat could not start its agent again: ${reason}`;
  return { turnId, startedAt: now, endedAt: now, stopReason: "error", parts: [errorPart(turnId, message, false, now, 0)] };
}

function errorPart(id: string, message: string, recoverable: boolean, ts: number, seq: number): ErrorPart {
  return { type: "error", id, message, recoverable, ts, seq, provenance: "native" };
}
