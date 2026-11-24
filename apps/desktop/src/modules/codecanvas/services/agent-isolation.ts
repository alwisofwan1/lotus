/**
 * Per-agent worktree isolation orchestration (ADR 0015). Ties the pure naming
 * helpers to the git worktree CRUD so a spawned agent gets its own branch +
 * worktree cut from the repo's current branch. Git access is injected as `deps`
 * so this is unit-testable without touching a real repo.
 */
import {
  slugify,
  agentBranchName,
  agentWorktreePath,
  uniqueSlug,
} from "./worktree-naming";
import type { WorktreeEntry } from "@/lib/tauri/canvas-git";
import type { Machine } from "./machine";
import { createWorktreeFor, listWorktreesFor, resolveHeadBranchFor } from "./remote-git";

export interface IsolationDeps {
  resolveHeadBranch: (repoPath: string) => Promise<string>;
  listWorktrees: (repoPath: string) => Promise<WorktreeEntry[]>;
  createWorktree: (
    repoPath: string,
    branch: string,
    worktreePath: string,
  ) => Promise<WorktreeEntry>;
}

export interface IsolateAgentInput {
  repoPath: string;
  teamLabel: string;
  agentLabel: string;
}

export interface AgentIsolation {
  branch: string;
  path: string;
  baseBranch: string;
}

export async function isolateAgentNode(
  input: IsolateAgentInput,
  deps: IsolationDeps,
): Promise<AgentIsolation> {
  const baseBranch = await deps.resolveHeadBranch(input.repoPath);
  const teamSlug = slugify(input.teamLabel);

  // Disambiguate against agent slugs already taken under this team's worktrees,
  // so two agents that slugify to the same token don't collide on branch/path.
  const teamPrefix = `${agentBranchName(teamSlug, "")}`; // "lotus/<team>/"
  const existing = await deps.listWorktrees(input.repoPath);
  const taken = existing
    .map((entry) => entry.branch)
    .filter((branch): branch is string => Boolean(branch?.startsWith(teamPrefix)))
    .map((branch) => branch.slice(teamPrefix.length));
  const agentSlug = uniqueSlug(slugify(input.agentLabel), taken);

  const branch = agentBranchName(teamSlug, agentSlug);
  const path = agentWorktreePath(input.repoPath, teamSlug, agentSlug);
  await deps.createWorktree(input.repoPath, branch, path);
  return { branch, path, baseBranch };
}

/**
 * `IsolationDeps` bound to the real git commands for a given machine — the production default
 * passed by the canvas spawn path. Tests inject their own deps instead.
 *
 * `null` means this machine. Nothing above this line knows the difference, and that is the point:
 * naming, slug disambiguation and the base-branch rule are the same work wherever the repo is.
 */
export function gitIsolationDepsFor(
  location: Machine | null | undefined,
): IsolationDeps {
  return {
    resolveHeadBranch: (repoPath) => resolveHeadBranchFor(location, repoPath),
    listWorktrees: (repoPath) => listWorktreesFor(location, repoPath),
    createWorktree: (repoPath, branch, worktreePath) =>
      createWorktreeFor(location, repoPath, branch, worktreePath),
  };
}

/** The local machine's deps, for callers that have no project location to hand. */
export const gitIsolationDeps: IsolationDeps = gitIsolationDepsFor(null);
