import type { ChatThread } from "@/modules/chat/runtime/chat-runtime-client";
import type { NeedsYouAsk } from "@/modules/codecanvas/services/needs-you-queue";
import { railState } from "@/modules/chat/domain/rail";
import { scoreCommandMatch } from "./command-items";
import type { PaneKind, RailPane, ShellMode } from "../types";

/** Where a Jump palette row takes the user (GLOSSARY "Jump palette"). */
export type JumpTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "pane"; paneId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "mode"; mode: ShellMode }
  /** A Factory run or an Automation Ask: it opens where it is answered. */
  | { kind: "ask"; open: () => void };

/** `waiting` and `done` are the two groups of Needs you (GLOSSARY); `done` is a result not seen yet. */
export type JumpStatus = "waiting" | "working" | "done";

export interface JumpItem {
  id: string;
  /** Which glyph the row wears. */
  icon: "workspace" | PaneKind | "mode" | NeedsYouAsk["source"];
  title: string;
  /** The quiet second text: which workspace or folder it lives in. */
  location: string;
  /** The SSH host it runs on; absent on this Mac. */
  host?: string;
  status?: JumpStatus;
  /** What a waiting agent asks, or what a stopped run waits for: the row's second line. */
  detail?: string;
  /** When it started waiting or finished, for the Needs you order; falls back to `at`. */
  since?: number;
  /** When it was last used, for the empty list's order and the row's age; 0 = never. */
  at: number;
  /** Words it answers to that the row does not show: agent, runner, folder. */
  keywords: string;
  target: JumpTarget;
}

export interface JumpWorkspace {
  id: string;
  name: string;
  folder: string;
  host?: string;
  panes: readonly RailPane[];
}

export interface JumpSources {
  workspaces: readonly JumpWorkspace[];
  threads: readonly ChatThread[];
  /** Chat threads shown in a pane, by pane id: such a thread is that pane's row, not a row of its own. */
  threadInPane: ReadonlyMap<string, string>;
  /** Last use of a workspace or pane, by id (`jump-recent.ts`). */
  recent: Readonly<Record<string, number>>;
  /** Stopped Factory runs and Automation Asks (`codecanvas/services/needs-you-sources.ts`). */
  asks?: readonly NeedsYouAsk[];
  /** The question a waiting pane's agent asked, by pane id (`pane-asks.ts`). */
  paneAsks?: ReadonlyMap<string, string>;
}

const MODES: { mode: ShellMode; title: string }[] = [
  { mode: "code", title: "Code" },
  { mode: "chat", title: "Chat" },
  { mode: "canvas", title: "Canvas" },
];

/** How many rows an empty query lists after the ones that need the user or are working. */
export const RECENT_LIMIT = 8;
export const SEARCH_LIMIT = 12;

function paneStatus(pane: RailPane): JumpStatus | undefined {
  if (pane.activity === "needs-you" || pane.activity === "failed") return "waiting";
  if (pane.activity === "working" || pane.activity === "starting") return "working";
  if (pane.unread) return "done";
  return undefined;
}

function threadStatus(thread: ChatThread): JumpStatus | undefined {
  const state = railState(thread);
  return state === "waiting" ? "waiting" : state === "running" ? "working" : state === "ready" ? "done" : undefined;
}

const tail = (path: string) => path.split("/").filter(Boolean).slice(-2).join("/") || path;

export function buildJumpItems({ workspaces, threads, threadInPane, recent, asks = [], paneAsks }: JumpSources): JumpItem[] {
  const items: JumpItem[] = [];
  for (const ws of workspaces) {
    items.push({
      id: `workspace:${ws.id}`,
      icon: "workspace",
      title: ws.name,
      location: tail(ws.folder),
      host: ws.host,
      at: recent[ws.id] ?? 0,
      keywords: ws.folder,
      target: { kind: "workspace", workspaceId: ws.id },
    });
    for (const pane of ws.panes) {
      const status = paneStatus(pane);
      items.push({
        id: `pane:${pane.id}`,
        icon: pane.kind,
        title: pane.persona && !pane.title.includes(pane.persona) ? `${pane.persona} · ${pane.title}` : pane.title,
        location: ws.name,
        host: ws.host,
        status,
        detail: status === "waiting" ? (pane.activity === "failed" ? "Failed" : paneAsks?.get(pane.id)) : undefined,
        since: pane.activitySince,
        at: recent[pane.id] ?? pane.activitySince ?? 0,
        keywords: [pane.persona, pane.runner?.label, pane.kind, pane.meta, ws.folder].filter(Boolean).join(" "),
        target: { kind: "pane", paneId: pane.id },
      });
    }
  }
  const inPanes = new Set(threadInPane.values());
  for (const thread of threads) {
    if (thread.archived || inPanes.has(thread.id)) continue;
    items.push({
      id: `thread:${thread.id}`,
      icon: "thread",
      title: thread.title ?? "New chat",
      location: `Chat · ${tail(thread.cwd)}`,
      host: thread.machine?.host,
      status: threadStatus(thread),
      since: thread.status === "waiting" ? thread.updatedAt : (thread.lastTurnEndedAt ?? undefined),
      at: Math.max(thread.lastReadAt ?? 0, thread.updatedAt),
      keywords: `chat ${thread.runner} ${thread.cwd}`,
      target: { kind: "thread", threadId: thread.id },
    });
  }
  for (const ask of asks) {
    items.push({
      id: ask.id,
      icon: ask.source,
      title: ask.name,
      location: ask.source === "factory" ? "Factory" : ask.source === "automation" ? "Automation" : "Tasks",
      status: "waiting",
      detail: ask.line,
      since: ask.askedAtMs,
      at: ask.askedAtMs,
      keywords: ask.source,
      target: { kind: "ask", open: ask.onOpen },
    });
  }
  for (const { mode, title } of MODES) {
    items.push({ id: `mode:${mode}`, icon: "mode", title, location: "Mode", at: 0, keywords: "mode switch", target: { kind: "mode", mode } });
  }
  return items;
}

const byRecent = (a: JumpItem, b: JumpItem) => b.at - a.at;
const sinceOf = (item: JumpItem) => item.since ?? item.at;

/** Needs you, Waiting group: the one that has waited longest first. */
export function waitingItems(items: readonly JumpItem[]): JumpItem[] {
  return items.filter((item) => item.status === "waiting").sort((a, b) => sinceOf(a) - sinceOf(b));
}

/** Needs you, Done-not-seen group: the newest result first. */
export function doneItems(items: readonly JumpItem[]): JumpItem[] {
  return items.filter((item) => item.status === "done").sort((a, b) => sinceOf(b) - sinceOf(a));
}

/** ⌘⇧J: the longest wait, else the oldest result nobody has opened. */
export function oldestNeedsYou(items: readonly JumpItem[]): JumpItem | undefined {
  return waitingItems(items)[0] ?? doneItems(items).at(-1);
}

/**
 * Opened empty: Needs you (Waiting, then Done not seen), then what is working, then the most
 * recently used. Modes wait for a query.
 */
export function emptyJumpList(items: readonly JumpItem[]): JumpItem[] {
  const working = items.filter((item) => item.status === "working").sort(byRecent);
  const recent = items
    .filter((item) => !item.status && item.at > 0)
    .sort(byRecent)
    .slice(0, RECENT_LIMIT);
  return [...waitingItems(items), ...doneItems(items), ...working, ...recent];
}

/** Every typed word must match; ties go to what needs the user, then to the most recent. */
export function searchJumpList(items: readonly JumpItem[], query: string): JumpItem[] {
  return items
    .map((item) => ({ item, score: scoreCommandMatch({ title: item.title, detail: `${item.location} ${item.host ?? ""}`, keywords: item.keywords }, query) }))
    .filter((hit): hit is { item: JumpItem; score: number } => hit.score !== null)
    .sort((a, b) => b.score - a.score || Number(b.item.status === "waiting") - Number(a.item.status === "waiting") || b.item.at - a.item.at)
    .slice(0, SEARCH_LIMIT)
    .map((hit) => hit.item);
}

/** "now", "5m", "3h", "2d": the row's age, short enough for a fixed column. */
export function jumpAge(at: number, now: number): string {
  if (at <= 0) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}
