import type { WorktreeEntry } from "@/lib/tauri/canvas-git";

export interface WorktreeAssignedNode {
  id: string;
  cwd: string;
  assignedWorktree: string | null;
  assignedWorktreePath: string | null;
}

/** Nodes that need their assignment cleared: branch no longer exists in any live worktree. */
export type StaleClearance = Map<string, { branch: null; path: null }>;

/**
 * Checks each node's `assignedWorktree` against the live worktrees in its repo.
 * Returns a map of nodeId → null-clearance for every stale assignment.
 * Nodes with no assignment, or whose branch is still live, are absent from the result.
 * A listFn error for a given cwd is swallowed — those nodes are left unchanged.
 */
export async function validateWorktreeAssignments(
  nodes: WorktreeAssignedNode[],
  listFn: (cwd: string) => Promise<WorktreeEntry[]>,
): Promise<StaleClearance> {
  const assigned = nodes.filter((n) => n.assignedWorktree !== null);
  if (assigned.length === 0) return new Map();

  // Group by cwd so we call listFn once per repo.
  const byCwd = new Map<string, WorktreeAssignedNode[]>();
  for (const n of assigned) {
    const existing = byCwd.get(n.cwd) ?? [];
    existing.push(n);
    byCwd.set(n.cwd, existing);
  }

  const stale: StaleClearance = new Map();

  await Promise.all(
    Array.from(byCwd.entries()).map(async ([cwd, group]) => {
      let entries: WorktreeEntry[];
      try {
        entries = await listFn(cwd);
      } catch {
        return; // can't validate — leave unchanged
      }
      const live = new Set(entries.map((e) => e.branch).filter(Boolean) as string[]);
      for (const n of group) {
        if (n.assignedWorktree && !live.has(n.assignedWorktree)) {
          stale.set(n.id, { branch: null, path: null });
        }
      }
    }),
  );

  return stale;
}
