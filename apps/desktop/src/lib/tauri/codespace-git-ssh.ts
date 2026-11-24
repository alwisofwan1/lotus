import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

import type {
  CodeSpaceStoredWorkspaceLocation,
  CodespaceGitDiffTarget,
  CodespaceGitFileDiffContent,
  CodespaceGitFileStatus,
  CodespaceGitPanelRefresh,
  CodespaceGitRepoSummary,
} from "./codespace";
import { toSshEditorContext, type SshToolTarget } from "./codespace-editor-ssh";

export type SshGitContext = {
  target: SshToolTarget;
  repoRoot: string;
};

const TAURI_ONLY = "SSH git commands require the Tauri runtime";

/**
 * Coerce a workspace `ssh` location to an `SshGitContext`. Mirrors
 * `toSshEditorContext` but uses the SSH `remoteCwd` as `repoRoot`. Returns
 * `null` when the location is not SSH or is missing required fields.
 */
export function toSshGitContext(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  repoRootOverride?: string,
): SshGitContext | null {
  // Only honor an absolute override. A non-absolute value (e.g. "~" leaking
  // from a stale `cell.rootDir`) would clobber a good `location.remoteCwd`
  // and trip `validate_remote_cwd` on the Rust side.
  const trimmedOverride = repoRootOverride?.trim();
  const absoluteOverride =
    trimmedOverride && trimmedOverride.startsWith("/") ? trimmedOverride : undefined;
  const editor = toSshEditorContext(
    location?.kind === "ssh" && absoluteOverride
      ? { ...location, remoteCwd: absoluteOverride }
      : location,
  );
  if (!editor) return null;
  return { target: editor.target, repoRoot: absoluteOverride || editor.remoteCwd };
}

export async function codespaceGitStatusSsh(
  context: SshGitContext,
): Promise<CodespaceGitFileStatus[]> {
  if (!isTauri()) return [];
  return tauriInvoke<CodespaceGitFileStatus[]>("codespace_git_status_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
  });
}

export async function codespaceGitRepoSummarySsh(
  context: SshGitContext,
): Promise<CodespaceGitRepoSummary | null> {
  if (!isTauri()) return null;
  return tauriInvoke<CodespaceGitRepoSummary>("codespace_git_repo_summary_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
  });
}

export async function codespaceGitStageFileSsh(
  context: SshGitContext,
  filePath: string,
): Promise<void> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke("codespace_git_stage_file_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
    filePath,
  });
}

export async function codespaceGitStageAllSsh(context: SshGitContext): Promise<void> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke("codespace_git_stage_all_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
  });
}

export async function codespaceGitUnstageFileSsh(
  context: SshGitContext,
  filePath: string,
): Promise<void> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke("codespace_git_unstage_file_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
    filePath,
  });
}

export async function codespaceGitUnstageAllSsh(context: SshGitContext): Promise<void> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke("codespace_git_unstage_all_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
  });
}

export async function codespaceGitDiscardAllChangesSsh(context: SshGitContext): Promise<void> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke("codespace_git_discard_all_changes_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
  });
}

export async function codespaceGitDiscardFileSsh(
  context: SshGitContext,
  filePath: string,
): Promise<void> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke("codespace_git_discard_file_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
    filePath,
  });
}

export async function codespaceGitDiffFileSsh(
  context: SshGitContext,
  filePath: string,
  diffTarget: CodespaceGitDiffTarget,
): Promise<string> {
  if (!isTauri()) return "";
  return tauriInvoke<string>("codespace_git_diff_file_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
    filePath,
    diffTarget,
  });
}

export async function codespaceGitDiffFileContentSsh(
  context: SshGitContext,
  filePath: string,
  diffTarget: CodespaceGitDiffTarget,
): Promise<CodespaceGitFileDiffContent> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke<CodespaceGitFileDiffContent>("codespace_git_diff_file_content_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
    filePath,
    diffTarget,
  });
}

export async function codespaceGitAiSuggestCommitSsh(context: SshGitContext): Promise<string> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke<string>("codespace_git_ai_suggest_commit_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
  });
}

export async function codespaceGitCommitSsh(
  context: SshGitContext,
  message: string,
): Promise<void> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke("codespace_git_commit_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
    message,
  });
}

export async function codespaceGitPushSsh(context: SshGitContext): Promise<void> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke("codespace_git_push_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
  });
}

export async function codespaceGitPanelRefreshSsh(
  context: SshGitContext,
): Promise<CodespaceGitPanelRefresh> {
  if (!isTauri()) throw new Error(TAURI_ONLY);
  return tauriInvoke<CodespaceGitPanelRefresh>("codespace_git_panel_refresh_ssh", {
    target: context.target,
    repoRoot: context.repoRoot,
  });
}
