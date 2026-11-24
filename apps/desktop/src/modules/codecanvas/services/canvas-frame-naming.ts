import type { Node } from "@xyflow/react";

/**
 * Auto-name for a new Frame (decision 27): the context its members share, else the caller's
 * "Frame N". Never guesses between competing contexts. Pure.
 */
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function worktreeLabel(data: Record<string, unknown>): string {
  const branch = str(data.assignedWorktree);
  if (branch) return branch;
  const path = str(data.assignedWorktreePath).replace(/\/+$/, "");
  return path ? path.slice(path.lastIndexOf("/") + 1) : "";
}

export function autoFrameName(members: readonly Node[], fallback: string): string {
  // Shared branch / worktree: every member that names one must name the same, and at least two do.
  const labels = members
    .map((n) => worktreeLabel((n.data ?? {}) as Record<string, unknown>))
    .filter(Boolean);
  if (labels.length >= 2 && labels.every((l) => l === labels[0])) return labels[0];

  const tasks = members.filter((n) => n.type === "task");
  if (tasks.length === 1) {
    const title = str((tasks[0].data as { title?: unknown }).title);
    if (title) return title;
  }
  return fallback;
}
