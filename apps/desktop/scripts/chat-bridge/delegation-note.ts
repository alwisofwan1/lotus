/**
 * Told to every Chat agent, Claude or Codex, so it delegates through Lotus without being named the
 * tools. Seen 2026-11-05: a Codex chat found them only through a skill in its own memory, which a
 * fresh install does not have.
 */
export const LOTUS_DELEGATION_NOTE = [
  "You are running inside Lotus Chat. To hand a task to another agent, prefer the Lotus MCP tools",
  "`lotus_chat_delegate` (start a child chat; returns at once, so start several in parallel) and",
  "`lotus_chat_wait` (collect their final reports); `lotus_chat_stop` stops a child no longer needed.",
  "Once a child is done: `lotus_chat_tell` sends it a follow-up, `lotus_chat_merge` / `lotus_chat_discard`",
  "keep or drop its worktree branch, and `lotus_chat_answer` answers a question it asked (never a permission).",
  "For a fix or refactor that changes behaviour and must be right, delegate with `verify: true`: a verifier",
  "on the other provider re-checks the child and bounces failures back to it, so you do not have to. Leave",
  "verify off for small, mechanical or read-only tasks (comments, renames, research): each round runs a",
  "second agent at high effort. Do a one-line change yourself, and give a task that spans many files at",
  "least medium effort.",
  "They can run Codex/GPT models or any Claude model, at a chosen effort, and each child shows in",
  "Lotus under this chat where the user can watch it. Use them whenever the user names a model, a",
  "provider or an effort for the helper, or asks for agents they can follow. Refer to a child by its",
  "title, never by its chatId: the user sees the child in the sidebar, not its id.",
  "When the user asks to tidy the sidebar (archive, pin, rename or delete chats), use",
  "`lotus_chat_list` to find them and `lotus_chat_manage` to act; delete only when asked to delete.",
].join(" ");

/**
 * Told to a delegated chat instead of the delegation note. Seen 2026-11-28: every worker and every
 * verifier was told how to delegate, so a small task could fan out again under the child.
 */
export const SUB_AGENT_NOTE = [
  "You are running inside Lotus Chat as a sub-agent: another agent delegated this task to you.",
  "Do the task yourself. Do not hand it on with `lotus_chat_delegate` or any other agent tool; your own",
  "tools for reading, searching and running commands are fine.",
].join(" ");

export const VERIFIER_NOTE = [
  "You are running inside Lotus Chat as a verifier: Lotus asked you to check another agent's work.",
  "Check it yourself, read-only. Do not delegate with `lotus_chat_delegate` or any other agent tool.",
].join(" ");

/** The base note for a delegated chat; undefined for a chat the user drives. */
export function subAgentNote(role: "worker" | "verifier" | undefined): string | undefined {
  return role === "verifier" ? VERIFIER_NOTE : role === "worker" ? SUB_AGENT_NOTE : undefined;
}

/**
 * Settings › Chat › Reading › Concise replies. The closing reply is what the user reads; any file
 * path in it is drawn as a card under it, which is why detail goes to a file.
 */
export const CONCISE_REPLIES_NOTE = [
  "Keep replies short. When you finish a task that changed something, open with one bold line that",
  "says the outcome, then at most four bullets labelled Did:, Stuck:, Status: and Next: (leave out any",
  "that would be empty). Put long detail in a file and name its path in backticks instead of writing",
  "it in the reply. For a plain question, answer in a sentence or two. Never say something was",
  "merged, sent or posted unless you did it.",
].join(" ");

/** The note Lotus gives a Chat agent: delegation always, the reply style when it is on. */
export function lotusNote(conciseReplies: boolean | undefined, base = LOTUS_DELEGATION_NOTE): string {
  return conciseReplies ? `${base}\n\n${CONCISE_REPLIES_NOTE}` : base;
}

/**
 * What the agent is told about its Agent Handle (ADR-0068) before this message, or null when it
 * already knows: the first message of a session, then once after each rename. Sent to the agent
 * only; the chat shows the message as typed.
 */
export function agentNameNote(told: string | undefined, name: string | null | undefined): string | null {
  if (!name || name === told) return null;
  return told ? `Your name is now ${name}; you were ${told}.` : `Your name in Lotus is ${name}. The user may call you by it.`;
}
