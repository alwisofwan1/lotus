import { uniqueAgentName, validateAgentName } from "@/lib/agent-catalog";

/** What a chat's Agent Handle needs to know about the other chats (ADR-0068). */
export type NamedThread = { id: string; cwd: string; archived: boolean; agentName?: string | null };

export type AgentRenameError = "empty" | "invalid-char" | "too-long" | "duplicate";

const ERROR_TEXT: Record<AgentRenameError, string> = {
  empty: "A name cannot be empty.",
  "invalid-char": "Letters, numbers, space, - and _ only.",
  "too-long": "32 characters at most.",
  duplicate: "Another chat in this folder has this name.",
};

export function agentRenameErrorText(error: AgentRenameError): string {
  return ERROR_TEXT[error];
}

/** Names in use by the other chats of the same folder that are not archived (decision 7). */
function takenNames(threads: readonly NamedThread[], thread: NamedThread): string[] {
  return threads.flatMap((t) => (t.id !== thread.id && !t.archived && t.cwd === thread.cwd && t.agentName ? [t.agentName] : []));
}

/** A free name for a chat opened without one; `pool` comes shuffled from the active Name Pool. */
export function pickAgentName(threads: readonly NamedThread[], thread: NamedThread, pool: readonly string[]): string {
  return uniqueAgentName("", takenNames(threads, thread), pool);
}

/** The typed name, checked; null when there is nothing to change. */
export function checkAgentRename(
  threads: readonly NamedThread[],
  thread: NamedThread,
  raw: string,
): { name: string } | { error: AgentRenameError } | null {
  const name = raw.trim();
  if (name === thread.agentName) return null;
  const check = validateAgentName(name, takenNames(threads, thread));
  return check.ok ? { name } : { error: check.reason };
}
