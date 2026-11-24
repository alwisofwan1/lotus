import type { Node } from "@xyflow/react";
import { worktreeLabel } from "./canvas-frame-naming";
import { frameIdOf } from "./canvas-frames";

/**
 * Frame Suggestion (decision 26): >= 2 loose nodes that share a worktree / branch, or that an agent
 * spawned for the same task, get a one-click "make a Frame" offer. Pure; never moves anything.
 *
 * "Spawned by the same agent" is read from `data.spawnTaskKey` (+ `spawnTaskTitle`), which the MCP
 * spawn bridge stamps on every cell spawned with a `task`. A task group is named after the task and
 * wins over a shared branch: it is the more specific statement of what the nodes are for.
 */
const NOT_WORK = new Set(["frame", "shape", "skill", "skills"]);

export const FRAME_SUGGESTION_MIN_NODES = 2;
export const FRAME_SUGGESTION_DISMISSED_KEY = "lotus.canvas.frameSuggestionDismissed";
const DISMISSED_CAP = 200;

export interface FrameSuggestion {
  /** Shared branch or worktree name; also the new Frame's auto-name. */
  context: string;
  /** Set when the group is "spawned for this task": the new Frame carries it so later spawns find it. */
  taskKey?: string;
  memberIds: string[];
  /** Context + sorted member ids: a new member changes it, so a dismissed set re-qualifies. */
  key: string;
}

export function suggestFrames(nodes: readonly Node[], dismissed: ReadonlySet<string> = new Set()): FrameSuggestion[] {
  const groups = new Map<string, { context: string; taskKey?: string; memberIds: string[] }>();
  for (const node of nodes) {
    if (NOT_WORK.has(node.type ?? "") || frameIdOf(node)) continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const taskKey = typeof data.spawnTaskKey === "string" && data.spawnTaskKey.trim() ? data.spawnTaskKey.trim() : undefined;
    const title = typeof data.spawnTaskTitle === "string" ? data.spawnTaskTitle.trim() : "";
    const context = taskKey ? title || taskKey : worktreeLabel(data);
    if (!context) continue;
    const groupKey = taskKey ? `task:${taskKey}` : `wt:${context}`;
    const group = groups.get(groupKey) ?? { context, ...(taskKey ? { taskKey } : {}), memberIds: [] };
    group.memberIds.push(node.id);
    groups.set(groupKey, group);
  }
  const out: FrameSuggestion[] = [];
  for (const { context, taskKey, memberIds } of groups.values()) {
    if (memberIds.length < FRAME_SUGGESTION_MIN_NODES) continue;
    const key = `${taskKey ? `task:${taskKey}` : context}|${[...memberIds].sort().join(",")}`;
    if (!dismissed.has(key)) out.push({ context, ...(taskKey ? { taskKey } : {}), memberIds, key });
  }
  return out.sort((a, b) => b.memberIds.length - a.memberIds.length);
}

/** At most one suggestion at a time: the biggest group. */
export function pickFrameSuggestion(nodes: readonly Node[], dismissed?: ReadonlySet<string>): FrameSuggestion | null {
  return suggestFrames(nodes, dismissed)[0] ?? null;
}

export function suggestionText(s: FrameSuggestion): string {
  return `${s.memberIds.length} node di ${s.context} → Jadikan Frame?`;
}

export function readDismissedSuggestions(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FRAME_SUGGESTION_DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeDismissedSuggestions(keys: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(FRAME_SUGGESTION_DISMISSED_KEY, JSON.stringify([...keys].slice(-DISMISSED_CAP)));
  } catch {
    /* blocked storage: the suggestion may reappear next session */
  }
}
