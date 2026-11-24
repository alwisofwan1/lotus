import { tauriInvoke } from "@/lib/tauri/runtime";

export type WorktreeEntry = {
  path: string;
  branch: string | null;
  isMain: boolean;
};

/** List all git worktrees for the repository containing `path`. Main worktree is first. */
export async function listGitWorktrees(path: string): Promise<WorktreeEntry[]> {
  return tauriInvoke<WorktreeEntry[]>("list_git_worktrees", { path });
}

/** Creates a linked worktree at `worktreePath` for `branch` (creates branch if missing). */
export async function createGitWorktree(repoPath: string, branch: string, worktreePath: string): Promise<WorktreeEntry> {
  return tauriInvoke<WorktreeEntry>("create_git_worktree", { repoPath, branch, worktreePath });
}

/** Removes the linked worktree at `worktreePath`. */
export async function removeGitWorktree(repoPath: string, worktreePath: string): Promise<void> {
  return tauriInvoke<void>("remove_git_worktree", { repoPath, worktreePath });
}

/** Returns the subset of `branches` that still correspond to a live worktree. */
export async function validateWorktreeBranches(repoPath: string, branches: string[]): Promise<string[]> {
  return tauriInvoke<string[]>("validate_worktree_branches", { repoPath, branches });
}

/** Current branch of the repo containing `repoPath` — the base branch new isolated-agent
 *  worktrees are cut from (ADR 0015). Rejects when HEAD is detached. */
export async function resolveRepoHeadBranch(repoPath: string): Promise<string> {
  return tauriInvoke<string>("resolve_repo_head_branch", { repoPath });
}

/** Unified diff of uncommitted tracked changes (`git diff HEAD`) in `cwd`. */
export async function gitUncommittedDiff(cwd: string): Promise<string> {
  return tauriInvoke<string>("git_diff", { projectPath: cwd, target: null });
}

// ── The same five, on another machine ─────────────────────────────────────────
//
// Siblings rather than replacements: a board on this machine keeps taking the commands above, and
// `modules/codecanvas/services/remote-git.ts` is what picks between them.

/** A machine, in the shape Rust's `SshToolTarget` expects. */
export interface SshMachine {
  host: string;
  user?: string | null;
  port?: number | null;
}

export async function listGitWorktreesSsh(target: SshMachine, path: string): Promise<WorktreeEntry[]> {
  return tauriInvoke<WorktreeEntry[]>("list_git_worktrees_ssh", { target, path });
}

export async function createGitWorktreeSsh(
  target: SshMachine,
  repoPath: string,
  branch: string,
  worktreePath: string,
): Promise<WorktreeEntry> {
  return tauriInvoke<WorktreeEntry>("create_git_worktree_ssh", { target, repoPath, branch, worktreePath });
}

export async function removeGitWorktreeSsh(
  target: SshMachine,
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  return tauriInvoke<void>("remove_git_worktree_ssh", { target, repoPath, worktreePath });
}

export async function validateWorktreeBranchesSsh(
  target: SshMachine,
  repoPath: string,
  branches: string[],
): Promise<string[]> {
  return tauriInvoke<string[]>("validate_worktree_branches_ssh", { target, repoPath, branches });
}

export async function resolveRepoHeadBranchSsh(target: SshMachine, repoPath: string): Promise<string> {
  return tauriInvoke<string>("resolve_repo_head_branch_ssh", { target, repoPath });
}

/** Unified diff of uncommitted tracked changes (`git diff HEAD`) in a remote `cwd`. */
export async function gitUncommittedDiffSsh(target: SshMachine, cwd: string): Promise<string> {
  return tauriInvoke<string>("git_diff_ssh", { target, projectPath: cwd });
}
