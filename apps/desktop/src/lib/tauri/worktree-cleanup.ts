import { tauriInvoke } from "@/lib/tauri/runtime";

/** Settings › Worktrees (`src-tauri/src/worktree_cleanup.rs`, plans/workspace-cleanup/PLAN.md). Local repos only. */

export type WorktreeKind = "yours" | "chat" | "factory";
export type WorktreeState = "merged" | "clean" | "hasWork";

export interface WorktreeRow {
  path: string;
  branch: string | null;
  sha: string | null;
  /** The repo's main checkout. */
  repo: string;
  kind: WorktreeKind;
  state: WorktreeState;
  /** What would be lost (Has work). */
  reason: string | null;
  /** Why it cannot be removed at all ("In use", "Factory cleans this up", "Locked by git"). */
  blocked: string | null;
  sizeBytes: number;
  /** 0 when unknown. */
  lastActiveMs: number;
}

export interface WorktreeRemoval {
  path: string;
  /** null: removed. */
  error: string | null;
}

export interface WorktreeLogEntry {
  atMs: number;
  path: string;
  repo: string;
  branch: string | null;
  sha: string | null;
  hadWork: boolean;
  auto: boolean;
}

/** Biggest first. Measures every folder, so it takes a moment on big repos. */
export function listWorktrees(): Promise<WorktreeRow[]> {
  return tauriInvoke("worktree_cleanup_list");
}

/** `discard`: also remove ones with work. Rust re-checks every row; one failure fails only that row. */
export function removeWorktrees(paths: string[], discard: boolean): Promise<WorktreeRemoval[]> {
  return tauriInvoke("worktree_cleanup_remove", { paths, discard });
}

/** The auto rule: Merged or Clean, not in use, untouched for `days`. */
export function autoCleanWorktrees(days: number): Promise<WorktreeRemoval[]> {
  return tauriInvoke("worktree_cleanup_auto", { days });
}

/** Removals of the last 30 days, newest first. */
export function worktreeCleanupLog(): Promise<WorktreeLogEntry[]> {
  return tauriInvoke("worktree_cleanup_log");
}

/** Clean up N and the auto rule take only these. */
export function isSafeToRemove(row: WorktreeRow): boolean {
  return row.blocked === null && row.state !== "hasWork";
}

/** `git branch <name> <sha>`, run in the repo, brings the removed branch back. */
export function restoreCommand(entry: WorktreeLogEntry): string | null {
  return entry.branch && entry.sha ? `git -C "${entry.repo}" branch ${entry.branch} ${entry.sha}` : null;
}

export interface WorktreeCleanupSettings {
  auto: boolean;
  days: number;
}

export const WORKTREE_CLEANUP_DAYS = { min: 1, max: 90, default: 7 } as const;

/** Off by default; days clamped to 1–90. */
export function readWorktreeCleanupSettings(settings: unknown): WorktreeCleanupSettings {
  const raw = (settings as { worktreeCleanup?: Partial<WorktreeCleanupSettings> } | null)?.worktreeCleanup;
  const days = typeof raw?.days === "number" && Number.isFinite(raw.days) ? Math.round(raw.days) : WORKTREE_CLEANUP_DAYS.default;
  return { auto: raw?.auto === true, days: Math.min(WORKTREE_CLEANUP_DAYS.max, Math.max(WORKTREE_CLEANUP_DAYS.min, days)) };
}
