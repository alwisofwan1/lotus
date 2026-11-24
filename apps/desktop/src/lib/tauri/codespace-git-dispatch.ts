/**
 * Workspace-aware git dispatchers.
 *
 * Each `*For` function inspects the workspace `location` and routes to either
 * the local `codespace_git_*` command (passing `repoRoot` directly) or the SSH
 * sibling (passing `target + repoRoot`). Existing call sites that pass a bare
 * `repoRoot` keep working — they call the original `codespaceGit*` exports.
 */

import {
  codespaceGitAiSuggestCommit,
  codespaceGitCommit,
  codespaceGitDiffFile,
  codespaceGitDiffFileContent,
  codespaceGitDiscardAllChanges,
  codespaceGitDiscardFile,
  codespaceGitPanelRefresh,
  codespaceGitPush,
  codespaceGitRepoSummary,
  codespaceGitStageAll,
  codespaceGitStageFile,
  codespaceGitStatus,
  codespaceGitUnstageAll,
  codespaceGitUnstageFile,
  type CodeSpaceStoredWorkspaceLocation,
  type CodespaceGitDiffTarget,
  type CodespaceGitFileDiffContent,
  type CodespaceGitFileStatus,
  type CodespaceGitPanelRefresh,
  type CodespaceGitRepoSummary,
} from "./codespace";
import {
  codespaceGitAiSuggestCommitSsh,
  codespaceGitCommitSsh,
  codespaceGitDiffFileContentSsh,
  codespaceGitDiffFileSsh,
  codespaceGitDiscardAllChangesSsh,
  codespaceGitDiscardFileSsh,
  codespaceGitPanelRefreshSsh,
  codespaceGitPushSsh,
  codespaceGitRepoSummarySsh,
  codespaceGitStageAllSsh,
  codespaceGitStageFileSsh,
  codespaceGitStatusSsh,
  codespaceGitUnstageAllSsh,
  codespaceGitUnstageFileSsh,
  toSshGitContext,
  type SshGitContext,
} from "./codespace-git-ssh";
import { createLocationDispatcher } from "./location-dispatcher";

// ── Dispatcher config ─────────────────────────────────────────────────────────

// For git, the same `repoRoot` override applies to both SSH and local paths.
const gitDispatcher = createLocationDispatcher<SshGitContext>({
  toSshContext: (location, override) =>
    toSshGitContext(location, override) ?? null,
  toLocalRoot: (location, override) =>
    override ?? (location?.kind === "local" ? location.cwd : ""),
});

type GitDispatchOptions = { repoRoot?: string };

// ── Dispatchers ───────────────────────────────────────────────────────────────

export function codespaceGitStatusFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  options: GitDispatchOptions = {},
): Promise<CodespaceGitFileStatus[]> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitStatusSsh(ctx),
    (repo) => codespaceGitStatus(repo),
    { kind: "fallback", value: [] },
  );
}

export function codespaceGitRepoSummaryFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  options: GitDispatchOptions = {},
): Promise<CodespaceGitRepoSummary | null> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitRepoSummarySsh(ctx),
    (repo) => codespaceGitRepoSummary(repo),
    { kind: "fallback", value: null },
  );
}

export function codespaceGitStageFileFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  filePath: string,
  options: GitDispatchOptions = {},
): Promise<void> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitStageFileSsh(ctx, filePath),
    (repo) => codespaceGitStageFile(repo, filePath),
    { kind: "throw", message: "codespaceGitStageFileFor requires a repo root or SSH context" },
  );
}

export function codespaceGitUnstageFileFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  filePath: string,
  options: GitDispatchOptions = {},
): Promise<void> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitUnstageFileSsh(ctx, filePath),
    (repo) => codespaceGitUnstageFile(repo, filePath),
    { kind: "throw", message: "codespaceGitUnstageFileFor requires a repo root or SSH context" },
  );
}

export function codespaceGitStageAllFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  options: GitDispatchOptions = {},
): Promise<void> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitStageAllSsh(ctx),
    (repo) => codespaceGitStageAll(repo),
    { kind: "throw", message: "codespaceGitStageAllFor requires a repo root or SSH context" },
  );
}

export function codespaceGitUnstageAllFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  options: GitDispatchOptions = {},
): Promise<void> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitUnstageAllSsh(ctx),
    (repo) => codespaceGitUnstageAll(repo),
    { kind: "throw", message: "codespaceGitUnstageAllFor requires a repo root or SSH context" },
  );
}

export function codespaceGitDiscardAllChangesFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  options: GitDispatchOptions = {},
): Promise<void> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitDiscardAllChangesSsh(ctx),
    (repo) => codespaceGitDiscardAllChanges(repo),
    { kind: "throw", message: "codespaceGitDiscardAllChangesFor requires a repo root or SSH context" },
  );
}

export function codespaceGitDiscardFileFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  filePath: string,
  options: GitDispatchOptions = {},
): Promise<void> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitDiscardFileSsh(ctx, filePath),
    (repo) => codespaceGitDiscardFile(repo, filePath),
    { kind: "throw", message: "codespaceGitDiscardFileFor requires a repo root or SSH context" },
  );
}

export function codespaceGitDiffFileFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  filePath: string,
  target: CodespaceGitDiffTarget,
  options: GitDispatchOptions = {},
): Promise<string> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitDiffFileSsh(ctx, filePath, target),
    (repo) => codespaceGitDiffFile(repo, filePath, target),
    { kind: "throw", message: "codespaceGitDiffFileFor requires a repo root or SSH context" },
  );
}

export function codespaceGitDiffFileContentFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  filePath: string,
  target: CodespaceGitDiffTarget,
  options: GitDispatchOptions = {},
): Promise<CodespaceGitFileDiffContent> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitDiffFileContentSsh(ctx, filePath, target),
    (repo) => codespaceGitDiffFileContent(repo, filePath, target),
    { kind: "throw", message: "codespaceGitDiffFileContentFor requires a repo root or SSH context" },
  );
}

/** The message is written by the Claude CLI on this machine, over SSH too. */
export function codespaceGitAiSuggestCommitFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  options: GitDispatchOptions = {},
): Promise<string> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitAiSuggestCommitSsh(ctx),
    (repo) => codespaceGitAiSuggestCommit(repo),
    { kind: "throw", message: "codespaceGitAiSuggestCommitFor requires a repo root or SSH context" },
  );
}

export function codespaceGitCommitFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  message: string,
  options: GitDispatchOptions = {},
): Promise<void> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitCommitSsh(ctx, message),
    (repo) => codespaceGitCommit(repo, message),
    { kind: "throw", message: "codespaceGitCommitFor requires a repo root or SSH context" },
  );
}

export function codespaceGitPushFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  options: GitDispatchOptions = {},
): Promise<void> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitPushSsh(ctx),
    (repo) => codespaceGitPush(repo),
    { kind: "throw", message: "codespaceGitPushFor requires a repo root or SSH context" },
  );
}

export function codespaceGitPanelRefreshFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  options: GitDispatchOptions = {},
): Promise<CodespaceGitPanelRefresh | null> {
  return gitDispatcher.route(
    location, options.repoRoot, options.repoRoot,
    (ctx) => codespaceGitPanelRefreshSsh(ctx),
    (repo) => codespaceGitPanelRefresh(repo),
    { kind: "fallback", value: null },
  );
}
