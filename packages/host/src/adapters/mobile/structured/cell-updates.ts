import type { ConversationUpdate } from "../../../types/conversation.js";
import { isClosingText, stepNotification, type Held } from "./cell-shapes.js";
import { entryFromPart } from "./entries-from-parts.js";
import { genUpdate } from "./saved-turns.js";
import type { StructuredSessionsDeps } from "./session-shapes.js";

/** One runner update, fanned out to the native lane, the cell's turn state and the hook-shaped notifications. */
export function applyCellUpdate(h: Held, u: ConversationUpdate, deps: StructuredSessionsDeps, save: (h: Held) => void): void {
  const now = Date.now();
  // Native first, and unconditionally: it is the runner's own account of the step, where
  // everything below is that account narrowed to the hook vocabulary.
  deps.publishConversation?.(h.member.paneId, h.member.agentType, genUpdate(u, h.gen));
  if (u.kind === "turn") {
    // Saved on open as well as close, so a turn cut by a crash still reaches `closeCutTurn`.
    save(h);
    if (u.turn.endedAt === undefined) {
      h.lastOpenTurnId = u.turn.turnId;
      setTurn(h, "running", now, deps);
    } else {
      setTurn(h, "idle", now, deps);
    }
    return;
  }
  // A text delta has no counterpart in the hook vocabulary and needs none: a streaming
  // `assistant_text` produces no entry either (`entryFromPart`), and the whole part is
  // published on both lanes the moment it settles.
  if (u.kind === "text") return;
  const closesTurn = u.part.type === "assistant_text" && u.part.state === "done" && isClosingText(h.session.conversation.page(), u.turnId, u.part.id);
  if (u.part.type === "permission") setTurn(h, u.part.outcome === undefined ? "needs-input" : "running", now, deps);
  const entry = entryFromPart(u.part, { closesTurn });
  if (entry !== undefined) deps.publishNotification(stepNotification(h.member, entry));
}

function setTurn(h: Held, turn: Held["turn"], at: number, deps: StructuredSessionsDeps): void {
  if (h.turn === turn) return;
  h.turn = turn;
  h.turnChangedAt = at;
  deps.fleetChanged();
}
