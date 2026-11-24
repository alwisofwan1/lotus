import type { ChatThread } from "@/modules/chat/runtime/chat-runtime-client";

type RailThread = Pick<ChatThread, "id" | "status" | "lastTurnEndedAt" | "parentId">;

export interface ChatTurnEnd {
  threadId: string;
  /** Held on an approval or a question rather than finished. */
  waiting: boolean;
}

/**
 * The chats that finished a turn, or started waiting on the user, between two rail listings — what
 * Chat's Agent-Done Alert announces. A thread not in `before` is a baseline (first listing, a new
 * chat), never a finish. A delegated chat (`parentId`) is its lead's to report, so it stays quiet.
 * `lastTurnEndedAt` moving catches a turn that started and ended between two listings.
 */
export function chatTurnEnds(before: ReadonlyMap<string, RailThread>, after: readonly RailThread[]): ChatTurnEnd[] {
  const ends: ChatTurnEnd[] = [];
  for (const thread of after) {
    const was = before.get(thread.id);
    if (!was || thread.parentId) continue;
    if (thread.status === "waiting") {
      if (was.status !== "waiting") ends.push({ threadId: thread.id, waiting: true });
    } else if (thread.status !== "working" && (thread.lastTurnEndedAt ?? 0) > (was.lastTurnEndedAt ?? 0)) {
      ends.push({ threadId: thread.id, waiting: false });
    }
  }
  return ends;
}
