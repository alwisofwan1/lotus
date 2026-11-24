// What the composer tells the user about a message sent now: when Claude will read it, and what
// Claude is doing meanwhile. Read from thread state only (plans/chat-runtime/PLAN.md findings 1, 8).

import type { Attachment } from "./thread-event";
import type { ThreadState } from "./thread-state";
import { stepTitle } from "./timeline";

// send: starts a turn. queue: the running turn has only written text, so the message waits for
// it to end — or is read after a step if Claude starts a tool first. steer: the turn has used a
// tool, so the message is read after the step in flight.
export type SendMode = "send" | "queue" | "steer";

export interface ComposerStatus {
  mode: SendMode;
  /** What the running turn is doing, for the status strip; null when no turn runs. */
  activity: string | null;
}

export interface SentMessage {
  clientRequestId: string;
  text: string;
  /** "send": shown at once as the user's message in the timeline, until its echo replaces it. */
  mode: SendMode;
  attachments?: Attachment[];
}

const TEXT_ONLY = new Set(["agentMessage", "reasoning", "userMessage"]);

export function composerStatus(state: ThreadState | null): ComposerStatus {
  const turn = state?.turns.at(-1);
  if (!state || turn?.status !== "running") return { mode: "send", activity: null };
  const usedTool = turn.items.some(({ item }) => !TEXT_ONLY.has(item.kind));
  const last = turn.items.at(-1)?.item;
  const activity = !last
    ? "Starting"
    : last.kind === "agentMessage"
      ? last.status === "running"
        ? "Writing a reply"
        : "Finishing"
      : last.kind === "userMessage"
        ? "Reading your message"
        : stepTitle(last, state.session.cwd);
  return { mode: usedTool ? "steer" : "queue", activity };
}

/** Sent messages Claude has not read yet. One leaves when the CLI echoes it (#275), never on a timer. */
export function unreadMessages(sent: readonly SentMessage[], state: ThreadState | null): SentMessage[] {
  if (!state) return [...sent];
  // An ended session never reads a queued message; a "send" starts the next session itself.
  if (state.session.ended) sent = sent.filter((m) => m.mode === "send");
  const read = new Set<string>();
  for (const turn of state.turns) {
    if (turn.input) read.add(turn.input.clientRequestId);
    for (const { item } of turn.items) if (item.kind === "userMessage") read.add(item.clientRequestId);
  }
  return sent.filter((message) => !read.has(message.clientRequestId));
}
