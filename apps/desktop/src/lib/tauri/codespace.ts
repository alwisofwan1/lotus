import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";
import { toWindowRect } from "@/lib/ui-zoom";
import type { TerminalV2LayoutTree } from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";

export type CodeSpaceStoredPane = {
  id: string;
  cwd: string;
  type?: "terminal" | "browser" | "workbench" | "orchestrator" | "chat";
  terminalCommand?: string[] | null;
  runtimeSessionId?: string | null;
  runtimeStatus?: string;
  agentCommand?: string | null;
  /** Terminal cell only: Lotus Claude account the pane runs on (issues/07). */
  claudeAccount?: string | null;
  url?: string | null;
  zoom?: number | null;
  /** Browser cell only: page title. Terminal cells use `paneTitle`. */
  title?: string | null;
  /** Terminal cell only: auto-generated conversation title (slice 4). */
  paneTitle?: string | null;
  /** Terminal cell only: epoch ms when `paneTitle` was last refreshed. */
  paneTitleUpdatedAt?: number | null;
  /** Terminal cell only: which agent conversation `paneTitle` names (its transcript path). */
  paneTitleSessionKey?: string | null;
  /** Terminal cell only: system-allocated human name (`Nara`, `Bima`) — slice 02. */
  agentName?: string | null;
  /** Read only, never written: an old rename, moved into `agentName` on restore (ADR-0068). */
  customDisplayName?: string | null;
  rootDir?: string | null;
  tabs?: Array<
    | { id: string; kind: "file"; filePath: string; dirty?: boolean }
    | { id: string; kind: "url"; url: string; title?: string }
  > | null;
  activeTabId?: string | null;
  sidebarCollapsed?: boolean | null;
  sidebarWidth?: number | null;
  teamId?: string | null;
  mode?: "bridge" | "fleet" | null;
  /**
   * Chat cell only: which conversation this pane shows.
   *
   * A REFERENCE, never the conversation itself. Messages live in the CodeChat store (SQLite),
   * so a workspace snapshot can never hold a stale copy of a thread, and deleting a snapshot
   * can never delete someone's chat.
   */
  sessionId?: string | null;
  /** Chat cell on New Chat (beta, 07d): the chat runtime thread, by reference like `sessionId`. */
  thread?: { id: string | null; title?: string } | null;
  /** Browser cell only: the agent pane its element picks go to. */
  linkedPaneId?: string | null;
};

export type CodeSpaceStoredWorkspaceLocation =
  | { kind: "local"; cwd: string }
  | {
      kind: "ssh";
      host: string;
      user?: string;
      port?: number;
      remoteCwd?: string;
      label?: string;
    };

export type CodeSpaceStoredWorkspace = {
  id: string;
  label: string;
  /**
   * Optional user-friendly slug shown in the right-side badge of agent
   * pane headers (slice 4 default = smart-truncated leaf path; slice 5
   * adds a rename UI). Falls back to the leaf folder name when absent.
   */
  name?: string | null;
  color: string;
  cwd: string;
  schemaVersion?: number | null;
  location?: CodeSpaceStoredWorkspaceLocation | null;
  rows: number;
  cols: number;
  rowFractions: number[];
  colFractions: number[];
  paneLayout?: {
    mode?: "grid" | "focus" | "main-right" | "main-bottom" | null;
    focusCellId?: string | null;
    terminalV2Layout?: TerminalV2LayoutTree | null;
    /** Code Frames; Rust stores the whole layout as opaque JSON, so no schema change. */
    frames?: unknown;
    framesMigrated?: boolean;
  } | null;
  /**
   * Retired with the CodeSpace right panel, and still declared on purpose.
   *
   * The snapshot lives in SQLite with a `right_panel_json` column, and Rust carries the value as
   * opaque JSON it never interprets. Nothing writes it any more; old rows still hold their last
   * value. Dropping the column means rebuilding the table — a migration that buys nothing, since
   * an unread column costs one NULL per workspace.
   */
  rightPanel?: unknown;
  cells: CodeSpaceStoredPane[];
};

export type CodeSpaceStoredSnapshot = {
  workspaces: CodeSpaceStoredWorkspace[];
  activeWorkspaceId?: string | null;
  focusedCellId?: string | null;
  updatedAt: number;
};

export async function loadCodeSpaceSnapshot(): Promise<CodeSpaceStoredSnapshot | null> {
  if (!isTauri()) return null;
  return tauriInvoke<CodeSpaceStoredSnapshot | null>("codespace_load_snapshot");
}

export async function saveCodeSpaceSnapshot(snapshot: CodeSpaceStoredSnapshot): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke("codespace_save_snapshot", { snapshot });
}

/** A workspace Lotus has seen, open or closed; newest first from {@link loadKnownWorkspaces}. */
export type CodeSpaceKnownWorkspace = {
  id: string;
  label: string;
  cwd: string;
  location?: unknown;
  lastSeenAt: number;
};

export async function loadKnownWorkspaces(): Promise<CodeSpaceKnownWorkspace[]> {
  if (!isTauri()) return [];
  return tauriInvoke<CodeSpaceKnownWorkspace[]>("codespace_known_workspaces");
}

export type CodeSpaceWebviewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function webviewCreate(label: string, url: string, bounds: CodeSpaceWebviewBounds): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke("webview_create", { label, url, bounds: toWindowRect(bounds) });
}

export async function webviewSetBounds(label: string, bounds: CodeSpaceWebviewBounds): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke("webview_set_bounds", { label, bounds: toWindowRect(bounds) });
}

export async function webviewNavigate(label: string, url: string): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke("webview_navigate", { label, url });
}

export async function webviewReload(label: string): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke("webview_reload", { label });
}

export async function webviewBack(label: string): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke("webview_back", { label });
}

export async function webviewForward(label: string): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke("webview_forward", { label });
}

export async function webviewSetVisible(label: string, visible: boolean): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke("webview_set_visible", { label, visible });
}

export async function webviewDestroy(label: string): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke("webview_destroy", { label });
}

export type BrowserAnnotationAgent = {
  id: string;
  label: string;
  kind: "claude" | "terminal" | "orchestrator";
  paneId?: string;
};

export type BrowserAnnotation = {
  id: string;
  agentId: string;
  url: string;
  title: string;
  selector: string;
  breadcrumb: string[];
  label: string;
  text: string;
  message: string;
  dimensions: { width: number; height: number };
  computedStyles: Record<string, string>;
  reactComponent?: string;
  classes: string[];
  summary: string[];
  outerHTML?: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  multiSelection?: BrowserAnnotation[];
  createdAt: string;
};

export type EditorReadFileResult = {
  content: string;
  mtime: number;
  sizeBytes: number;
  binary: boolean;
  /** How the text is stored (`utf8`, `utf8bom`, `utf16le`, `utf16be`, `windows1252`); saves keep it. */
  encoding?: string;
  /** Not read because of its size (`binary` is set too); `allowLarge` reads it anyway. */
  tooLarge?: boolean;
};

/** Read options: `allowLarge` lifts the 10 MB text cap to 50 MB ("Open anyway"). */
export type EditorReadOptions = { allowLarge?: boolean };

export type EditorWriteFileResult = {
  mtime: number;
};

export type EditorCreateEntryResult = {
  path: string;
};

export type EditorListEntry = {
  path: string;
  kind: "file" | "directory";
  /** Git-ignored, or a build/dependency folder. Shown, but dimmed (local listings only). */
  ignored?: boolean;
};

/** Every file under a root, for Go to file. `truncated` when the index hit its size cap. */
export type EditorFileIndex = {
  files: string[];
  truncated: boolean;
};

export type CodespaceGitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "unmerged";

export type CodespaceGitFileStatus = {
  path: string;
  relativePath: string;
  staged: CodespaceGitChangeKind | null;
  unstaged: CodespaceGitChangeKind | null;
};

export type CodespaceGitDiffTarget = "staged" | "unstaged";

export type CodespaceGitFileDiffContent = {
  original: string;
  modified: string;
  originalPath: string;
  modifiedPath: string;
};

export type CodespaceGitRepoSummary = {
  branch: string;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type CodespaceGitPanelRefresh = {
  summary: CodespaceGitRepoSummary;
  files: CodespaceGitFileStatus[];
};

export async function editorReadFile(path: string, options: EditorReadOptions = {}): Promise<EditorReadFileResult> {
  if (!isTauri()) {
    throw new Error("editor_read_file is only available in Tauri");
  }
  return tauriInvoke<EditorReadFileResult>(
    "editor_read_file",
    options.allowLarge ? { path, allowLarge: true } : { path },
  );
}

/** The raw bytes of a file, for the media viewer (an ArrayBuffer, not JSON). */
export async function editorReadFileBytes(path: string): Promise<ArrayBuffer> {
  if (!isTauri()) {
    throw new Error("editor_read_file_bytes is only available in Tauri");
  }
  return tauriInvoke<ArrayBuffer>("editor_read_file_bytes", { path });
}

export async function editorWriteFile(
  path: string,
  content: string,
  expectedMtime?: number,
  encoding?: string,
): Promise<EditorWriteFileResult> {
  if (!isTauri()) {
    throw new Error("editor_write_file is only available in Tauri");
  }
  return tauriInvoke<EditorWriteFileResult>(
    "editor_write_file",
    encoding ? { path, content, expectedMtime, encoding } : { path, content, expectedMtime },
  );
}

/** Find in files (`editor_search.rs`). */
export type EditorSearchQuery = {
  pattern: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Globs to search only, comma separated. */
  include?: string;
  /** Globs to leave out, comma separated. */
  exclude?: string;
};

export type EditorSearchMatch = {
  /** 1-based line. */
  line: number;
  /** 1-based column, UTF-16 units: what Monaco and JS strings count. */
  column: number;
  length: number;
  /** The text around the match; the match starts at `previewStart`. */
  preview: string;
  previewStart: number;
};

export type EditorSearchFile = { path: string; matches: EditorSearchMatch[] };

export type EditorSearchResult = {
  files: EditorSearchFile[];
  matchCount: number;
  truncated: boolean;
  cancelled: boolean;
};

/**
 * Searches the workspace: locally under `root`, over SSH under the host's folder. `searchId`
 * names a local search so `editorSearchCancel` can stop it when a newer one starts.
 */
export async function editorSearchFor(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  root: string,
  query: EditorSearchQuery,
  searchId: string,
): Promise<EditorSearchResult> {
  if (!isTauri()) throw new Error("Search is only available in the desktop app");
  if (location?.kind === "ssh") {
    const host = location.host?.trim();
    if (!host) throw new Error("This SSH workspace has no host");
    return tauriInvoke<EditorSearchResult>("editor_search_ssh", {
      target: { host, user: location.user?.trim() || null, port: typeof location.port === "number" ? location.port : null },
      remoteCwd: root,
      query,
    });
  }
  return tauriInvoke<EditorSearchResult>("editor_search", { root, query, searchId });
}

export async function editorSearchCancel(searchId: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("editor_search_cancel", { searchId });
}

/** Hot exit (`editor_backup.rs`): a copy of an unsaved buffer, kept on disk under `key`. */
export async function editorBackupWrite(key: string, data: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("editor_backup_write", { key, data });
}

export async function editorBackupRead(key: string): Promise<string | null> {
  if (!isTauri()) return null;
  return tauriInvoke<string | null>("editor_backup_read", { key });
}

export async function editorBackupDelete(key: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("editor_backup_delete", { key });
}

export async function editorCreateFile(root: string, relativePath: string): Promise<EditorCreateEntryResult> {
  if (!isTauri()) {
    throw new Error("editor_create_file is only available in Tauri");
  }
  return tauriInvoke<EditorCreateEntryResult>("editor_create_file", { root, relativePath });
}

export async function editorCreateDirectory(root: string, relativePath: string): Promise<EditorCreateEntryResult> {
  if (!isTauri()) {
    throw new Error("editor_create_directory is only available in Tauri");
  }
  return tauriInvoke<EditorCreateEntryResult>("editor_create_directory", { root, relativePath });
}

export async function editorDeleteEntry(root: string, relativePath: string): Promise<EditorCreateEntryResult> {
  if (!isTauri()) {
    throw new Error("editor_delete_entry is only available in Tauri");
  }
  return tauriInvoke<EditorCreateEntryResult>("editor_delete_entry", { root, relativePath });
}

export async function editorRenameEntry(
  root: string,
  fromRelativePath: string,
  toRelativePath: string,
): Promise<EditorCreateEntryResult> {
  if (!isTauri()) {
    throw new Error("editor_rename_entry is only available in Tauri");
  }
  return tauriInvoke<EditorCreateEntryResult>("editor_rename_entry", { root, fromRelativePath, toRelativePath });
}

/** Show a local entry selected in Finder. There is no Finder for an SSH workspace. */
export async function editorRevealEntry(root: string, relativePath: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("editor_reveal_entry is only available in Tauri");
  }
  return tauriInvoke<void>("editor_reveal_entry", { root, relativePath });
}

export async function editorListFiles(root: string, maxDepth?: number): Promise<string[]> {
  if (!isTauri()) {
    return [];
  }
  return tauriInvoke<string[]>("editor_list_files", { root, maxDepth });
}

export async function editorListEntries(root: string, maxDepth?: number): Promise<EditorListEntry[]> {
  if (!isTauri()) {
    return [];
  }
  return tauriInvoke<EditorListEntry[]>("editor_list_entries", { root, maxDepth });
}

/** Rust sends paths relative to `root` with `/`; joined back with the root's own separator. */
export async function editorIndexFiles(root: string): Promise<EditorFileIndex> {
  if (!isTauri()) return { files: [], truncated: false };
  const index = await tauriInvoke<EditorFileIndex>("editor_index_files", { root });
  const base = root.replace(/[\\/]+$/, "");
  const join = root.includes("\\")
    ? (path: string) => `${base}\\${path.replace(/\//g, "\\")}`
    : (path: string) => `${base}/${path}`;
  return { files: index.files.map(join), truncated: index.truncated };
}

// Workspace-aware dispatchers live in dedicated modules. Re-exported here so
// callers can keep importing from `@/lib/tauri/codespace`.
export {
  editorCreateDirectoryFor,
  editorCreateFileFor,
  editorDeleteEntryFor,
  editorIndexFilesFor,
  editorListDirectoryFor,
  editorListEntriesFor,
  editorReadFileBytesFor,
  editorReadFileFor,
  editorRenameEntryFor,
  editorWriteFileFor,
} from "./codespace-editor-dispatch";

export {
  codespaceGitAiSuggestCommitFor,
  codespaceGitCommitFor,
  codespaceGitDiffFileContentFor,
  codespaceGitDiffFileFor,
  codespaceGitDiscardAllChangesFor,
  codespaceGitDiscardFileFor,
  codespaceGitPanelRefreshFor,
  codespaceGitPushFor,
  codespaceGitRepoSummaryFor,
  codespaceGitStageAllFor,
  codespaceGitStageFileFor,
  codespaceGitStatusFor,
  codespaceGitUnstageAllFor,
  codespaceGitUnstageFileFor,
} from "./codespace-git-dispatch";

export async function codespaceGitStatus(repoRoot: string): Promise<CodespaceGitFileStatus[]> {
  if (!isTauri()) {
    return [];
  }
  return tauriInvoke<CodespaceGitFileStatus[]>("codespace_git_status", { repoRoot });
}

export async function codespaceGitDiscoverRepos(workspaceRoot: string): Promise<string[]> {
  if (!isTauri()) {
    return [];
  }
  return tauriInvoke<string[]>("codespace_git_discover_repos", { workspaceRoot });
}

export async function codespaceGitRepoSummary(repoRoot: string): Promise<CodespaceGitRepoSummary | null> {
  if (!isTauri()) {
    return null;
  }
  return tauriInvoke<CodespaceGitRepoSummary>("codespace_git_repo_summary", { repoRoot });
}

export async function codespaceGitPanelRefresh(repoRoot: string): Promise<CodespaceGitPanelRefresh | null> {
  if (!isTauri()) return null;
  return tauriInvoke<CodespaceGitPanelRefresh>("codespace_git_panel_refresh", { repoRoot });
}

export async function codespaceGitStageFile(repoRoot: string, filePath: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("codespace_git_stage_file is only available in Tauri");
  }
  return tauriInvoke("codespace_git_stage_file", { repoRoot, filePath });
}

export async function codespaceGitStageAll(repoRoot: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("codespace_git_stage_all is only available in Tauri");
  }
  return tauriInvoke("codespace_git_stage_all", { repoRoot });
}

export async function codespaceGitUnstageFile(repoRoot: string, filePath: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("codespace_git_unstage_file is only available in Tauri");
  }
  return tauriInvoke("codespace_git_unstage_file", { repoRoot, filePath });
}

export async function codespaceGitUnstageAll(repoRoot: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("codespace_git_unstage_all is only available in Tauri");
  }
  return tauriInvoke("codespace_git_unstage_all", { repoRoot });
}

export async function codespaceGitDiscardAllChanges(repoRoot: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("codespace_git_discard_all_changes is only available in Tauri");
  }
  return tauriInvoke("codespace_git_discard_all_changes", { repoRoot });
}

export async function codespaceGitDiscardFile(repoRoot: string, filePath: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("codespace_git_discard_file is only available in Tauri");
  }
  return tauriInvoke("codespace_git_discard_file", { repoRoot, filePath });
}

export async function codespaceGitCommit(repoRoot: string, message: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("codespace_git_commit is only available in Tauri");
  }
  return tauriInvoke("codespace_git_commit", { repoRoot, message });
}

export async function codespaceGitPush(repoRoot: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("codespace_git_push is only available in Tauri");
  }
  return tauriInvoke("codespace_git_push", { repoRoot });
}

export async function codespaceGitAiSuggestCommit(repoRoot: string): Promise<string> {
  if (!isTauri()) {
    throw new Error("codespace_git_ai_suggest_commit is only available in Tauri");
  }
  return tauriInvoke<string>("codespace_git_ai_suggest_commit", { repoRoot });
}

export async function codespaceGitDiffFile(
  repoRoot: string,
  filePath: string,
  target: CodespaceGitDiffTarget,
): Promise<string> {
  if (!isTauri()) {
    return "";
  }
  return tauriInvoke<string>("codespace_git_diff_file", { repoRoot, filePath, target });
}

export async function codespaceGitDiffFileContent(
  repoRoot: string,
  filePath: string,
  target: CodespaceGitDiffTarget,
): Promise<CodespaceGitFileDiffContent> {
  if (!isTauri()) {
    return {
      original: "",
      modified: "",
      originalPath: "original://empty",
      modifiedPath: "modified://empty",
    };
  }
  return tauriInvoke<CodespaceGitFileDiffContent>("codespace_git_diff_file_content", { repoRoot, filePath, target });
}

export type AgentHooksHealth = {
  scripts_installed: boolean;
  stop_hook_registered: boolean;
  notification_hook_registered: boolean;
};

export function getAgentHooksHealth(): Promise<AgentHooksHealth> {
  if (!isTauri()) {
    return Promise.resolve({
      scripts_installed: false,
      stop_hook_registered: false,
      notification_hook_registered: false,
    });
  }
  return tauriInvoke<AgentHooksHealth>("get_agent_hooks_health");
}
