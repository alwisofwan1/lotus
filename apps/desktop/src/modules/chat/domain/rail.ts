// The rail and the start screen (#287; mockups/lotus-chat.fig, pages "06b Rail" and "06c New chat").

import type { ChatStats, ChatThread } from "../runtime/chat-runtime-client";

export function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** Where a chat runs, for the rail's second line: "app", or "app · devbox-vps" on an SSH machine,
 *  plus "offline" while that machine's host does not answer (mockups/chat-remote-machine.html). */
export function placeName(thread: Pick<ChatThread, "cwd" | "machine" | "link">): string {
  const where = thread.machine ? `${folderName(thread.cwd)} · ${thread.machine.host}` : folderName(thread.cwd);
  return thread.link === "down" ? `${where} · offline` : where;
}

/** One formatter for every mode's titles; it lives with the shared title control. */
export { displayTitle } from "@/modules/conversation-title/domain";

export interface RailGroup {
  cwd: string;
  /** The folder's name, with its machine when it is on one. */
  label: string;
  threads: ChatThread[];
}

/** Threads grouped by folder; groups and threads keep the list's order (newest first). Archived
 *  threads are left out: they live in the rail's Archived drawer (#291). */
export function railGroups(threads: readonly ChatThread[]): RailGroup[] {
  const groups = new Map<string, ChatThread[]>();
  // The same path on another machine is another folder.
  const key = (t: ChatThread) => (t.machine ? `${t.machine.host}:${t.cwd}` : t.cwd);
  for (const thread of threads) if (!thread.archived) groups.set(key(thread), [...(groups.get(key(thread)) ?? []), thread]);
  return [...groups].map(([, list]) => ({ cwd: list[0].cwd, label: placeName({ ...list[0], link: null }), threads: list }));
}

/** Where a thread sits in the Command Rail (plans/chat-command-rail/PLAN.md). */
export type RailState = "ready" | "waiting" | "running" | "read";

export function railState(thread: Pick<ChatThread, "status" | "lastTurnEndedAt" | "lastReadAt">): RailState {
  if (thread.status === "waiting") return "waiting";
  if (thread.status === "working") return "running";
  return (thread.lastTurnEndedAt ?? 0) > (thread.lastReadAt ?? 0) ? "ready" : "read";
}

/**
 * Delegated chats by the chat that made them, oldest first (the order they were handed out).
 * A chat whose parent is gone from the list is not here: it stands on its own.
 */
export function railChildren(threads: readonly ChatThread[]): Map<string, ChatThread[]> {
  const ids = new Set(threads.map((thread) => thread.id));
  const children = new Map<string, ChatThread[]>();
  for (const thread of threads) {
    if (!thread.parentId || !ids.has(thread.parentId)) continue;
    children.set(thread.parentId, [...(children.get(thread.parentId) ?? []), thread]);
  }
  for (const list of children.values()) list.sort((a, b) => a.createdAt - b.createdAt);
  return children;
}

/** Every chat below `id`, depth first, with how deep each sits (1 = a direct child). */
export function railDescendants(id: string, children: Map<string, ChatThread[]>, depth = 1): { thread: ChatThread; depth: number }[] {
  // Depth is capped as a guard: the runtime refuses a chain past 3, a cycle would never end.
  if (depth > 8) return [];
  return (children.get(id) ?? []).flatMap((thread) => [{ thread, depth }, ...railDescendants(thread.id, children, depth + 1)]);
}

/** A thread's state with its delegated chats rolled up: one waiting on you, or still working, shows on the lead. */
export function railTreeState(thread: ChatThread, children: Map<string, ChatThread[]>): RailState {
  const states = [thread, ...railDescendants(thread.id, children).map((d) => d.thread)].map(railState);
  if (states.includes("waiting")) return "waiting";
  if (states.includes("running")) return "running";
  return states[0];
}

/** A Delegate Verify checker. Before the `role` column, one was known only by its title. */
export function isVerifier(thread: Pick<ChatThread, "role" | "title">): boolean {
  return thread.role === "verifier" || /^verify · .* · r\d+$/.test(thread.title ?? "");
}

/** A worker's verify loop for its row's second line: "verifying 1/2", "verified", …; null = none. */
export function verifyLabel(thread: Pick<ChatThread, "verify">): string | null {
  const v = thread.verify;
  if (!v) return null;
  if (v.status === "verifying") return v.round ? `verifying ${v.round}/${v.rounds}` : "verify queued";
  if (v.status === "passed") return "verified ✓";
  if (v.status === "unverified") return `unverified ${v.round}/${v.rounds}`;
  if (v.status === "blocked") return "blocked";
  return null;
}

/** The rows drawn under a delegated chat: a verifier is folded into its worker's row (the
 *  second line says how verify goes) and shows only while it works, waits on you, or is open. */
export function visibleChildren(list: readonly ChatThread[], activeId: string | null): ChatThread[] {
  return list.filter((t) => !isVerifier(t) || t.id === activeId || ["running", "waiting"].includes(railState(t)));
}

/** "3 agents · 1 working"; null when it delegated nothing. Verifiers are Lotus's, not agents it delegated. */
export function agentsLine(thread: ChatThread, children: Map<string, ChatThread[]>): string | null {
  const all = railDescendants(thread.id, children).filter((d) => !isVerifier(d.thread)).map((d) => railState(d.thread));
  if (all.length === 0) return null;
  const waiting = all.filter((s) => s === "waiting").length;
  const working = all.filter((s) => s === "running").length;
  const tail = waiting ? `${waiting} waiting` : working ? `${working} working` : "done";
  return `${all.length} ${all.length === 1 ? "agent" : "agents"} · ${tail}`;
}

export interface RailSection {
  id: "pinned" | "ready" | "running" | "earlier";
  label: string;
  threads: { thread: ChatThread; state: RailState }[];
}

/**
 * Pinned (kept for follow-up, newest pin first, never reordered by activity; plans/chat-thread-pin),
 * then Ready (news, or waiting on you), then Running, then Earlier; archived left out, empty sections
 * dropped. A pinned thread sits only in Pinned, its state drawn on its row. A delegated chat
 * sits under its lead, whose state rolls up its children's. `heldId` is the thread just opened from Ready: drawn read, it keeps its place until
 * another one is opened. Running is ordered by when each turn started, newest first.
 */
export function railSections(
  threads: readonly ChatThread[],
  heldId: string | null,
): RailSection[] {
  const sections: RailSection[] = [
    { id: "pinned", label: "Pinned", threads: [] },
    { id: "ready", label: "Ready", threads: [] },
    { id: "running", label: "Running", threads: [] },
    { id: "earlier", label: "Earlier", threads: [] },
  ];
  const children = railChildren(threads);
  const nested = new Set([...children.values()].flat().map((thread) => thread.id));
  for (const thread of threads) {
    // A delegated chat is drawn under its lead, not in a section of its own.
    if (thread.archived || nested.has(thread.id)) continue;
    const state = railTreeState(thread, children);
    const held = thread.id === heldId && state === "read";
    const section = thread.pinnedAt ? 0 : held || state === "ready" || state === "waiting" ? 1 : state === "running" ? 2 : 3;
    sections[section].threads.push({ thread, state });
  }
  const ended = (t: ChatThread) => t.lastTurnEndedAt ?? t.updatedAt;
  sections[0].threads.sort((a, b) => (b.thread.pinnedAt ?? 0) - (a.thread.pinnedAt ?? 0));
  sections[1].threads.sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting") || ended(b.thread) - ended(a.thread));
  sections[2].threads.sort((a, b) => (b.thread.turnStartedAt ?? 0) - (a.thread.turnStartedAt ?? 0));
  sections[3].threads.sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);
  return sections.filter((section) => section.threads.length > 0);
}

export interface ChatTabMark {
  kind: "waiting" | "ready";
  count: number;
}

/** What the Chat tab shows while another mode is open: waiting wins over ready; null when nothing needs you. */
export function chatTabMark(threads: readonly ChatThread[]): ChatTabMark | null {
  let waiting = 0;
  let ready = 0;
  for (const thread of threads) {
    if (thread.archived) continue;
    const state = railState(thread);
    if (state === "waiting") waiting++;
    else if (state === "ready") ready++;
  }
  if (waiting) return { kind: "waiting", count: waiting };
  return ready ? { kind: "ready", count: ready } : null;
}

/** The rail's right-hand time: "now", "12m", "3h", "4d", then the date. */
export function shortSince(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days < 7) return `${Math.max(days, 1)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** What a thread is doing, when it is doing something: "Thinking", "Waiting for you". */
export function statusLabel(thread: Pick<ChatThread, "status">): string | null {
  return thread.status === "working" ? "Thinking" : thread.status === "waiting" ? "Waiting for you" : null;
}

/** "just now", "12m ago", "3h ago", "yesterday", "4d ago", then the date. */
export function sinceLabel(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60 && new Date(at).getDate() === new Date(now).getDate()) return `${Math.floor(minutes / 60)}h ago`;
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** "Today · 12 turns · agents worked 41m · 228k tokens"; null before the first turn of the day. */
export function statsLine(stats: ChatStats | null): string | null {
  if (!stats || stats.turns === 0) return null;
  const minutes = Math.round(stats.durationMs / 60_000);
  const worked = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return [
    "Today",
    `${stats.turns} ${stats.turns === 1 ? "turn" : "turns"}`,
    `agents worked ${worked}`,
    `${compact(stats.tokens)} tokens`,
  ].join(" · ");
}

/** Short lines on the craft, each checked against its source. One per new chat. */
export const QUOTES: readonly { text: string; by: string }[] = [
  { text: "Simplicity is prerequisite for reliability.", by: "Edsger W. Dijkstra" },
  { text: "Talk is cheap. Show me the code.", by: "Linus Torvalds" },
  { text: "Make it work, make it right, make it fast.", by: "Kent Beck" },
  { text: "Premature optimization is the root of all evil.", by: "Donald Knuth" },
  { text: "Programs must be written for people to read, and only incidentally for machines to execute.", by: "Harold Abelson" },
  { text: "Any fool can write code that a computer can understand. Good programmers write code that humans can understand.", by: "Martin Fowler" },
];
