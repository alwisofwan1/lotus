import {
  createGitWorktree,
  createGitWorktreeSsh,
  gitUncommittedDiff,
  gitUncommittedDiffSsh,
  listGitWorktrees,
  listGitWorktreesSsh,
  removeGitWorktree,
  removeGitWorktreeSsh,
  resolveRepoHeadBranch,
  resolveRepoHeadBranchSsh,
  validateWorktreeBranches,
  validateWorktreeBranchesSsh,
  type WorktreeEntry,
} from "@/lib/tauri/canvas-git";
import { wireTarget, type Machine } from "./machine";

/**
 * Worktrees and diffs, on whichever machine the project lives.
 *
 * **Nothing about isolation changes for a remote project.** The branch naming, the slug
 * disambiguation, the staleness sweep, the rule that git — never Lotus — decides whether a branch
 * can be checked out twice: all of it is the same code, and in Rust the scripts are the same git
 * commands. These dispatchers exist so no caller has to remember which machine it is on.
 *
 * **One thing is stricter here, and deliberately so.** ADR 0015's hazard is that concurrent sessions
 * share a worktree and a checkout moves the branch under the others. On a remote machine the
 * operator cannot glance at the directory to see what is running there, so the remote scripts never
 * pass `--force` — not to `worktree add`, which is what stops two agents landing on one branch, and
 * not to `worktree remove`, which is the only warning before an agent's uncommitted work is gone.
 */
export type CanvasLocation = Machine | null | undefined;

export function listWorktreesFor(location: CanvasLocation, repoPath: string): Promise<WorktreeEntry[]> {
  if (!location) return listGitWorktrees(repoPath);
  return listGitWorktreesSsh(wireTarget(location), repoPath);
}

export function createWorktreeFor(
  location: CanvasLocation,
  repoPath: string,
  branch: string,
  worktreePath: string,
): Promise<WorktreeEntry> {
  if (!location) return createGitWorktree(repoPath, branch, worktreePath);
  return createGitWorktreeSsh(wireTarget(location), repoPath, branch, worktreePath);
}

export function removeWorktreeFor(
  location: CanvasLocation,
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  if (!location) return removeGitWorktree(repoPath, worktreePath);
  return removeGitWorktreeSsh(wireTarget(location), repoPath, worktreePath);
}

export function validateWorktreeBranchesFor(
  location: CanvasLocation,
  repoPath: string,
  branches: string[],
): Promise<string[]> {
  if (!location) return validateWorktreeBranches(repoPath, branches);
  return validateWorktreeBranchesSsh(wireTarget(location), repoPath, branches);
}

export function resolveHeadBranchFor(location: CanvasLocation, repoPath: string): Promise<string> {
  if (!location) return resolveRepoHeadBranch(repoPath);
  return resolveRepoHeadBranchSsh(wireTarget(location), repoPath);
}

export function uncommittedDiffFor(location: CanvasLocation, cwd: string): Promise<string> {
  if (!location) return gitUncommittedDiff(cwd);
  return gitUncommittedDiffSsh(wireTarget(location), cwd);
}
