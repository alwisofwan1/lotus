"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, FilePlus, Files, GitBranch, GitGraph, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import {
  isTauri,
  type CodespaceGitDiffTarget,
  type CodespaceGitFileDiffContent,
  type EditorListEntry,
} from "@/lib/tauri-api";
import {
  codespaceGitAiSuggestCommitFor,
  codespaceGitCommitFor,
  codespaceGitDiffFileContentFor,
  codespaceGitDiffFileFor,
  codespaceGitDiscardAllChangesFor,
  codespaceGitDiscardFileFor,
  codespaceGitPushFor,
  codespaceGitStageAllFor,
  codespaceGitStageFileFor,
  codespaceGitUnstageAllFor,
  codespaceGitUnstageFileFor,
  editorCreateDirectoryFor,
  editorCreateFileFor,
  editorDeleteEntryFor,
  editorIndexFilesFor,
  editorListDirectoryFor,
  editorRenameEntryFor,
  editorRevealEntry,
  type CodeSpaceStoredWorkspaceLocation,
  type EditorSearchMatch,
} from "@/lib/tauri/codespace";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { isPathTab, type DiffTabTarget, type WorkbenchCellData, type WorkbenchPathTab, type WorkbenchTab } from "./types";
import { FileTree } from "./workbench/FileTree";
import { WorkbenchBrowserTab } from "./workbench/WorkbenchBrowserTab";
import { WorkbenchConflictBanner } from "./workbench/WorkbenchConflictBanner";
import { WorkbenchTrustBanner } from "./workbench/WorkbenchTrustBanner";
import { WorkbenchDiffTab } from "./workbench/WorkbenchDiffTab";
import { WorkbenchEditor } from "./workbench/WorkbenchEditor";
import { WorkbenchMarkdownPreview } from "./workbench/WorkbenchMarkdownPreview";
import { WorkbenchMediaPreview } from "./workbench/WorkbenchMediaPreview";
import { SourceControlPanel } from "./workbench/SourceControlPanel";
import { SearchPanel } from "./workbench/SearchPanel";
import { WorkbenchTabBar } from "./workbench/WorkbenchTabBar";
import {
  diffTabId,
  fileTabId,
  openCommitInTabs,
  openGraphInTabs,
  tabIndexShortcut,
} from "@/modules/codespace/services/workbench-tab-state";
import { GitGraphView } from "./git-graph/GitGraphView";
import { GitCommitView } from "./git-graph/GitCommitView";
import { useMultiRepoGit } from "@/modules/codespace/hooks/useMultiRepoGit";
import { useWorkbenchSession } from "@/modules/codespace/hooks/useWorkbenchSession";
import { describeError, fileName, isInsideRoot, normalizePath } from "@/modules/codespace/services/workbench-paths";
import { resolveEditorLanguage } from "@/modules/codespace/services/editor-languages";
import { editorMediaType } from "@/modules/codespace/services/editor-media";
import { buildCodeSpaceWebviewLabel } from "@/modules/codespace/services/webview-registry";
import {
  EDITOR_LARGE_FILE_LIMIT_BYTES,
  getEditorFileBuffers,
  getEditorFileBuffer,
  moveEditorFileBuffers,
  readEditorFileBytes,
  releaseEditorFileBuffer,
} from "@/modules/codespace/services/editor-file-store";
import {
  canSplitEditor,
  onWorkbenchOpen,
  requestEditorSplit,
  requestWorkbenchOpen,
  takeWorkbenchOpen,
} from "@/modules/codespace/services/workbench-open";
import { GoToFilePalette, type PaletteCommand } from "@/modules/codespace/components/workbench/GoToFilePalette";
import { WorkbenchLauncher, type LauncherAction } from "@/modules/codespace/components/workbench/WorkbenchLauncher";
import {
  forgetRecentFiles,
  listRecentFiles,
  moveRecentFiles,
  recordRecentFile,
  type RecentFile,
} from "@/modules/codespace/services/recent-files";
import { UnsavedChangesDialog } from "@/modules/codespace/components/workbench/UnsavedChangesDialog";
import { WorkbenchBreadcrumb } from "@/modules/codespace/components/workbench/WorkbenchBreadcrumb";
import { WorkbenchStatusBar } from "@/modules/codespace/components/workbench/WorkbenchStatusBar";
import { useEditorPreferences } from "@/modules/codespace/hooks/useEditorPreferences";
import { useLspStatus } from "@/modules/codespace/hooks/useLspStatus";
import {
  notifyLspFilesChanged,
  onLspNotice,
  restartLspForFile,
  stopAllLsp,
} from "@/modules/codespace/services/lsp/lsp-manager";
import { isFolderTrusted, trustKey } from "@/modules/codespace/services/lsp/lsp-trust";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  EDITOR_AUTO_SAVE_OPTIONS,
  stepEditorFontSize,
} from "@/modules/codespace/services/editor-preferences";
import type { EditorStatus } from "@/modules/codespace/services/editor-status";
import type { DiffLayout } from "@/modules/codespace/services/diff-layout";
import {
  buildCodeSelectionPayload,
  buildDiffSelectionPayload,
  buildPathPayload,
  formatPathRange,
  withAskAboutLine,
} from "@/modules/codespace/services/selection-payload";
import { sendSelectionToAgent } from "@/modules/codespace/services/selection-send";
import type { EditorLineSelection, SelectionAction } from "./workbench/SelectionPopover";
import type { DiffEditorSelection } from "./workbench/WorkbenchDiffPreview";
import { useInlineBlame } from "@/modules/codespace/hooks/useInlineBlame";
import { blameAt, blameStatus } from "@/modules/codespace/services/inline-blame";
import { hasPrimaryModifier } from "@/lib/hotkeys/platform-chords";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

interface WorkbenchCellProps {
  cell: WorkbenchCellData;
  enabled?: boolean;
  allowUrlTabs?: boolean;
  onCellChange?: (updater: (cell: WorkbenchCellData) => WorkbenchCellData) => void;
  /**
   * Workspace location. When `kind === "ssh"` the editor + git operations
   * route through `*_ssh` Tauri commands; when `kind === "local"` (or
   * `undefined`) they keep the existing local code path. Components that
   * don't yet thread the workspace through can omit this prop — the
   * dispatchers fall back to `cell.rootDir` for local mode.
   */
  location?: CodeSpaceStoredWorkspaceLocation | null;
}

const FILE_INDEX_MAX_AGE_MS = 30_000;
/** `MAX_LISTED_ENTRIES` in editor_fs.rs: a local folder listing stops there. */
const LISTED_ENTRIES_CAP = 10_000;

/** One counter for the app: a pane that restarts must not repeat a number its editor has seen. */
let revealNonce = 0;


function makeRelativePath(rootDir: string, path: string): string {
  if (!path.startsWith(rootDir)) return path;
  return path.slice(rootDir.length).replace(/^[/\\]+/, "") || path;
}

/** On/off editor preferences offered in the `>` palette. */
const EDITOR_TOGGLE_COMMANDS = [
  { preference: "formatOnSave", name: "format on save" },
  { preference: "trimTrailingWhitespace", name: "trim trailing whitespace on save" },
  { preference: "insertFinalNewline", name: "final newline on save" },
  { preference: "minimap", name: "minimap" },
  { preference: "stickyScroll", name: "sticky scroll" },
  { preference: "inlineBlame", name: "inline blame" },
] as const;

/**
 * ⌘ on a Mac, Ctrl elsewhere; either one alone when the webview names no platform at all
 * (`navigator.platform` empty, as under jsdom).
 */
function isPrimaryChord(event: KeyboardEvent): boolean {
  if (!navigator.platform) return event.metaKey !== event.ctrlKey;
  return hasPrimaryModifier(event);
}

function getInitialTabs(cell: WorkbenchCellData, allowUrlTabs: boolean): WorkbenchTab[] {
  return allowUrlTabs ? cell.tabs : cell.tabs.filter((tab) => tab.kind !== "url");
}

type WorkbenchSidebarMode = "files" | "source" | "search" | "graph";

export function WorkbenchCell({
  cell,
  enabled = true,
  allowUrlTabs = true,
  onCellChange,
  location,
}: WorkbenchCellProps) {
  const initialTabs = useMemo(() => getInitialTabs(cell, allowUrlTabs), [allowUrlTabs, cell]);
  const shortcut = useFormatShortcut();
  const initialActiveTab = useMemo(() => {
    if (initialTabs.some((tab) => tab.id === cell.activeTabId)) return cell.activeTabId;
    return initialTabs[0]?.id ?? null;
  }, [cell.activeTabId, initialTabs]);
  // One listing per folder that has been opened, read when the tree first shows it open.
  const [directoryListings, setDirectoryListings] = useState<ReadonlyMap<string, EditorListEntry[]>>(() => new Map());
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(() => new Set());
  // A commit, push or AI suggest running in Source, for the status bar.
  const [gitActivity, setGitActivity] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState("");
  const [diffFileContent, setDiffFileContent] = useState<CodespaceGitFileDiffContent>({
    original: "",
    modified: "",
    originalPath: "original://empty",
    modifiedPath: "modified://empty",
  });
  const [diffLoading, setDiffLoading] = useState(false);
  // Which file and side the diff on screen belongs to. Reading the same one again keeps it shown,
  // so a git refresh does not blank the diff and lose the scroll.
  const [diffLoadedKey, setDiffLoadedKey] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  // Split or inline picked by hand in any diff tab of this pane; null follows the width.
  const [manualDiffLayout, setManualDiffLayout] = useState<DiffLayout | null>(null);
  // Clicking a file in Source reads its diff again, even when that tab is already showing.
  const [diffReadRequest, setDiffReadRequest] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [goToFileOpen, setGoToFileOpen] = useState(false);
  const [fileIndex, setFileIndex] = useState<{ key: string; files: string[]; truncated: boolean; at: number; error: string | null } | null>(null);
  const [goToFileInitialQuery, setGoToFileInitialQuery] = useState("");
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [editorPreferences, updateEditorPreferences] = useEditorPreferences();
  const { wordWrap, fontSize: editorFontSize } = editorPreferences;
  const [editorStatus, setEditorStatus] = useState<EditorStatus | null>(null);
  const [treeCreateRequest, setTreeCreateRequest] = useState<{ kind: "file" | "folder"; nonce: number } | null>(null);
  const [treeRevealRequest, setTreeRevealRequest] = useState(0);
  // Where focus was before ⌘P, so closing the palette puts it back and ⌘P keeps working.
  const focusBeforeGoToFileRef = useRef<HTMLElement | null>(null);
  const [revealRequest, setRevealRequest] = useState<{
    path: string;
    startLine: number;
    endLine: number;
    startColumn?: number;
    endColumn?: number;
    nonce: number;
  } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(Boolean(cell.sidebarCollapsed));
  const [sidebarMode, setSidebarMode] = useState<WorkbenchSidebarMode>("files");
  const [searchFocusRequest, setSearchFocusRequest] = useState<{ nonce: number } | null>(null);
  const searchOpened = searchFocusRequest !== null;
  // Graph mounts when first opened, then stays: its scroll, scope and query wait while you read a commit.
  const [graphOpened, setGraphOpened] = useState(false);
  const [graphRepoPicked, setGraphRepoPicked] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [sidebarWidthLocal, setSidebarWidthLocal] = useState(cell.sidebarWidth ?? 206);
  const sidebarWidthRef = useRef(sidebarWidthLocal);
  const isSshWorkspace = location?.kind === "ssh";

  const fallbackEntries = useMemo<EditorListEntry[]>(() => {
    return cell.tabs
      .filter((tab): tab is Extract<WorkbenchTab, { kind: "file" }> => tab.kind === "file")
      .map((tab) => ({ path: tab.filePath, kind: "file" }));
  }, [cell.tabs]);

  const [entriesError, setEntriesError] = useState<string | null>(null);
  const directoryListingsRef = useRef(directoryListings);
  useEffect(() => {
    directoryListingsRef.current = directoryListings;
  }, [directoryListings]);

  // Which tree the listings belong to. A result that comes back after the pane moved to another
  // folder or machine is dropped instead of landing in the new tree.
  const listingKey = `${location?.kind === "ssh" ? `ssh:${location.user ?? ""}@${location.host}:${location.port ?? ""}` : "local"}|${cell.rootDir}`;
  const listingKeyRef = useRef(listingKey);

  const loadDirectory = useCallback(async (directory: string, options: { force?: boolean } = {}) => {
    if (!enabled || !isTauri()) return;
    const key = listingKey;
    setLoadingDirectories((previous) => new Set(previous).add(directory));
    try {
      const entries = await editorListDirectoryFor(location ?? null, directory, { cache: true, force: options.force });
      if (listingKeyRef.current !== key) return;
      setDirectoryListings((previous) => new Map(previous).set(directory, entries));
      if (directory === cell.rootDir) setEntriesError(null);
    } catch (err) {
      if (listingKeyRef.current !== key) return;
      // An unreadable folder shows empty instead of being asked for again and again.
      setDirectoryListings((previous) => new Map(previous).set(directory, []));
      if (directory === cell.rootDir) setEntriesError(describeError(err));
    } finally {
      setLoadingDirectories((previous) => {
        const next = new Set(previous);
        next.delete(directory);
        return next;
      });
    }
  }, [cell.rootDir, enabled, listingKey, location]);

  const refreshEntries = useCallback(async (options: { force?: boolean } = {}) => {
    const directories = new Set([cell.rootDir, ...directoryListingsRef.current.keys()]);
    await Promise.all([...directories].map((directory) => loadDirectory(directory, options)));
  }, [cell.rootDir, loadDirectory]);

  useEffect(() => {
    // A different folder or machine starts from its root again. Switching the pane off and on
    // keeps what was read.
    if (listingKeyRef.current !== listingKey) {
      listingKeyRef.current = listingKey;
      setDirectoryListings(new Map());
      setLoadingDirectories(new Set());
      directoryListingsRef.current = new Map();
    }
    if (enabled && !directoryListingsRef.current.has(cell.rootDir)) void loadDirectory(cell.rootDir);
  }, [cell.rootDir, enabled, listingKey, loadDirectory]);

  const listedEntries = useMemo(
    () => [...directoryListings.values()].flat(),
    [directoryListings],
  );
  const loadedDirectories = useMemo(() => new Set(directoryListings.keys()), [directoryListings]);
  // A remote listing has no cap.
  const truncatedDirectories = useMemo(() => new Set(
    location?.kind === "ssh"
      ? []
      : [...directoryListings].filter(([, entries]) => entries.length >= LISTED_ENTRIES_CAP).map(([directory]) => directory),
  ), [directoryListings, location?.kind]);

  const availableEntries = useMemo(() => {
    const merged = isTauri()
      ? [...fallbackEntries, ...listedEntries]
      : [...fallbackEntries];
    const byPath = new Map<string, EditorListEntry>();
    for (const entry of merged) {
      byPath.set(entry.path, entry);
    }
    return Array.from(byPath.values());
  }, [fallbackEntries, listedEntries]);

  const {
    tabs,
    activeTabId,
    activeTab,
    activeFilePath,
    activeDirty,
    activeLanguage,
    commitTabs,
    openFileTab,
    openFileTabRef,
    openDiffTab,
    closeTab,
    closeTabsNow,
    closeTabsInScope,
    keepPreviewTab,
    pinTab,
    reorderTab,
    addUrlTab,
    reopenClosedTab,
    canReopenTab,
    pendingClose,
    setPendingClose,
    savePendingClose,
    editorIoContext,
    editorApiRef,
    loading,
    content,
    binary,
    error,
    loadedPath,
    mediaVersion,
    saveError,
    diskNotice,
    setDiskNotice,
    activeEditorConfig,
    activeGitBaseline,
    handleEditorChange,
    handleEditorBlur,
    openLargeFile,
    clearShownFile,
    handleSave,
    saveDirtyFile,
    saveAllDirtyFiles,
    diskConflicts,
    deletedFiles,
    endDiskConflicts,
    remapTrackedPaths,
    reloadFromDisk,
    overwriteDisk,
    diskAgainstEdits,
    forgetLocalEdits,
    gitStatuses,
    gitStatusByPath,
    gitSummary,
    gitAvailable,
    gitLoading,
    gitError,
    setGitError,
    refreshGitStatus,
    refreshGitStatusForVisibleView,
  } = useWorkbenchSession({
    holderId: cell.id,
    location,
    rootDir: cell.rootDir,
    enabled,
    initialTabs,
    initialActiveTabId: initialActiveTab,
    allowUrlTabs,
    preferences: editorPreferences,
    // SSH has no watcher: git is read only while Source is showing.
    gitVisible: sidebarMode === "source",
    onTabsChange: (patch) => onCellChange?.((current) => ({ ...current, ...patch })),
    onFileMissing: (path) => {
      forgetRecentFiles(listingKey, path);
      setRecentFiles(listRecentFiles(listingKey));
    },
    // The session has synced its own tabs; the tree's listings and the language servers follow.
    onDiskChange: (change) => {
      if (change.overflow) {
        void refreshEntries({ force: true });
      } else {
        // A file added, removed or renamed shows in its folder's listing, if that folder is open.
        const folders = new Set(change.paths.map((path) => path.slice(0, path.lastIndexOf("/")) || "/"));
        for (const directory of directoryListingsRef.current.keys()) {
          if (folders.has(normalizePath(directory).replace(/\/+$/, ""))) void loadDirectory(directory, { force: true });
        }
      }
      notifyLspFilesChanged(null, change.paths);
    },
  });
  const activeUrl = activeTab?.kind === "url" ? activeTab.url : "";
  const activeWebviewLabel = buildCodeSpaceWebviewLabel("workbench", cell.id, activeTab?.id ?? "preview");
  const activeMedia = editorMediaType(activeFilePath);
  // Text with a rendered view beside its source: Markdown, and SVG (drawn by the media viewer).
  const previewKind = activeLanguage === "markdown" ? "markdown" : activeMedia?.textual ? "svg" : null;

  const activeDiffTab = activeTab?.kind === "diff" ? activeTab : null;
  const multiGit = useMultiRepoGit({
    roots: [cell.rootDir],
    location: location ?? null,
    // The Graph lists the same repositories in its picker, and counts their uncommitted files.
    enabled: enabled && (sidebarMode === "source" || sidebarMode === "graph"),
  });
  const activeDiffRepoRoot = activeDiffTab?.repoRoot ?? cell.rootDir;
  const activeDiffStatus = activeDiffTab
    ? (activeDiffRepoRoot === cell.rootDir
      ? gitStatusByPath.get(activeDiffTab.filePath)
      : multiGit.repos.get(activeDiffRepoRoot)?.statuses.find((status) => status.path === activeDiffTab.filePath)) ?? null
    : null;
  const activeDiffSides = useMemo<CodespaceGitDiffTarget[]>(() => {
    if (!activeDiffStatus) return [];
    return [
      ...(activeDiffStatus.unstaged ? ["unstaged" as const] : []),
      ...(activeDiffStatus.staged ? ["staged" as const] : []),
    ];
  }, [activeDiffStatus]);
  const sourceChangeCount = multiGit.totalChanges || gitStatuses.length;
  const graphRepos = useMemo(() => {
    const roots = multiGit.repos.size > 0 ? [...multiGit.repos.keys()] : [cell.rootDir];
    return roots.map((root) => ({ root, label: root === cell.rootDir ? fileName(root) || root : makeRelativePath(cell.rootDir, root) }));
  }, [cell.rootDir, multiGit.repos]);
  // Picked in the Graph, else the repository of the file in front, else the pane's folder (Q9).
  const graphRepoRoot = (graphRepoPicked && graphRepos.some((repo) => repo.root === graphRepoPicked) ? graphRepoPicked : null)
    ?? graphRepos
      .filter((repo) => activeFilePath && (activeFilePath === repo.root || activeFilePath.startsWith(`${repo.root}/`) || activeFilePath.startsWith(`${repo.root}\\`)))
      .sort((a, b) => b.root.length - a.root.length)[0]?.root
    ?? graphRepos[0]?.root
    ?? cell.rootDir;
  const graphUncommitted = multiGit.repos.get(graphRepoRoot)?.statuses.length
    ?? (graphRepoRoot === cell.rootDir ? gitStatuses.length : 0);
  const openCommitTab = useCallback((repoRoot: string, sha: string, subject?: string) => {
    const next = openCommitInTabs(tabs, repoRoot, sha, subject || undefined);
    commitTabs(next.tabs, next.activeTabId);
  }, [commitTabs, tabs]);
  const openGraphTab = useCallback((repoRoot: string) => {
    const next = openGraphInTabs(tabs, repoRoot);
    commitTabs(next.tabs, next.activeTabId);
  }, [commitTabs, tabs]);
  const showGraph = useCallback(() => {
    setGraphOpened(true);
    setSidebarMode("graph");
  }, []);
  const hasSourceChanges = sourceChangeCount > 0;


  useEffect(() => {
    setSidebarCollapsed(Boolean(cell.sidebarCollapsed));
  }, [cell.id, cell.sidebarCollapsed]);


  const setWorkbenchSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    onCellChange?.((current) => ({
      ...current,
      sidebarCollapsed: collapsed,
      sidebarWidth: sidebarWidthRef.current,
    }));
  }, [onCellChange]);

  const handleResizeMouseDown = useCallback((e: { preventDefault(): void; clientX: number }) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;

    const onMove = (ev: MouseEvent) => {
      const next = Math.min(480, Math.max(140, startWidth + ev.clientX - startX));
      sidebarWidthRef.current = next;
      setSidebarWidthLocal(next);
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      onCellChange?.((c) => ({ ...c, sidebarWidth: sidebarWidthRef.current }));
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [onCellChange]);


  useEffect(() => {
    if (!enabled) return;
    const takeRequest = () => {
      const request = takeWorkbenchOpen(cell.id);
      if (!request) return;
      openFileTabRef.current(request.path);
      revealNonce += 1;
      setRevealRequest(request.startLine !== undefined
        ? { path: request.path, startLine: request.startLine, endLine: request.endLine ?? request.startLine, nonce: revealNonce }
        : null);
    };
    takeRequest();
    return onWorkbenchOpen(cell.id, takeRequest);
  }, [cell.id, enabled, openFileTabRef]);

  const createFile = useCallback(async (relativePath: string) => {
    const created = await editorCreateFileFor(location ?? null, relativePath, {
      localRoot: cell.rootDir,
      remoteRoot: cell.rootDir,
    });
    await refreshEntries();
    refreshGitStatusForVisibleView();
    openFileTab(created.path);
  }, [cell.rootDir, location, openFileTab, refreshEntries, refreshGitStatusForVisibleView]);

  const createFolder = useCallback(async (relativePath: string) => {
    await editorCreateDirectoryFor(location ?? null, relativePath, {
      localRoot: cell.rootDir,
      remoteRoot: cell.rootDir,
    });
    await refreshEntries();
  }, [cell.rootDir, location, refreshEntries]);

  const deleteEntry = useCallback(async (relativePath: string, kind: "file" | "directory") => {
    const deleted = await editorDeleteEntryFor(location ?? null, relativePath, {
      localRoot: cell.rootDir,
      remoteRoot: cell.rootDir,
    });
    const deletedPath = normalizePath(deleted.path);
    endDiskConflicts((path) => isInsideRoot(deletedPath, path));
    forgetRecentFiles(listingKey, deletedPath);
    setRecentFiles(listRecentFiles(listingKey));
    const affectedTabs = tabs.filter((tab): tab is WorkbenchPathTab => {
      if (!isPathTab(tab)) return false;
      const tabPath = normalizePath(tab.filePath);
      return kind === "file"
        ? tabPath === deletedPath
        : tabPath === deletedPath || tabPath.startsWith(`${deletedPath}/`);
    });

    if (affectedTabs.length > 0) {
      const affectedIds = new Set(affectedTabs.map((tab) => tab.id));
      for (const tab of affectedTabs) {
        if (tab.kind === "file") releaseEditorFileBuffer(tab.filePath, cell.id);
      }
      const nextTabs = tabs.filter((tab) => !affectedIds.has(tab.id));
      const activeDeleted = activeTabId ? affectedIds.has(activeTabId) : false;
      const activeIndex = activeTabId ? tabs.findIndex((tab) => tab.id === activeTabId) : -1;
      const nextActiveTabId = activeDeleted
        ? nextTabs[Math.max(0, activeIndex - 1)]?.id ?? nextTabs[0]?.id ?? null
        : activeTabId;
      commitTabs(nextTabs, nextActiveTabId);

      if (activeDeleted) {
        clearShownFile();
      }
    }

    await refreshEntries();
    refreshGitStatusForVisibleView();
  }, [activeTabId, cell.id, cell.rootDir, commitTabs, clearShownFile, endDiskConflicts, listingKey, location, refreshEntries, refreshGitStatusForVisibleView, tabs]);

  const renameEntry = useCallback(async (fromRelativePath: string, toRelativePath: string, kind: "file" | "directory") => {
    await editorRenameEntryFor(location ?? null, fromRelativePath, toRelativePath, {
      localRoot: cell.rootDir,
      remoteRoot: cell.rootDir,
    });
    const root = normalizePath(cell.rootDir).replace(/\/+$/, "");
    const from = `${root}/${fromRelativePath}`;
    const to = `${root}/${toRelativePath}`;
    const moved = (path: string) => {
      const normalized = normalizePath(path);
      if (normalized === from) return to;
      if (kind === "directory" && normalized.startsWith(`${from}/`)) return `${to}${normalized.slice(from.length)}`;
      return null;
    };
    // Open tabs follow the file, and so do their unsaved edits, its place in Recent and a
    // conflict banner.
    moveEditorFileBuffers(from, to);
    remapTrackedPaths(moved);
    moveRecentFiles(listingKey, from, to);
    setRecentFiles(listRecentFiles(listingKey));
    if (tabs.some((tab) => isPathTab(tab) && moved(tab.filePath) !== null)) {
      // The id follows the path too, so a new file at the old path does not land on this tab.
      let nextActiveTabId = activeTabId;
      commitTabs(tabs.map((tab) => {
        const next = isPathTab(tab) ? moved(tab.filePath) : null;
        if (next === null) return tab;
        const id = tab.kind === "diff" ? diffTabId(next, tab.target) : fileTabId(next);
        if (tab.id === activeTabId) nextActiveTabId = id;
        return { ...tab, id, filePath: next };
      }), nextActiveTabId);
    }
    if (kind === "directory") {
      // The old folder's listings would read as a folder that is still there.
      setDirectoryListings((previous) => new Map([...previous].filter(([directory]) => moved(directory) === null)));
    }
    await refreshEntries();
    refreshGitStatusForVisibleView();
  }, [activeTabId, cell.rootDir, commitTabs, listingKey, location, refreshEntries, refreshGitStatusForVisibleView, remapTrackedPaths, tabs]);

  const revealEntry = useCallback(
    (relativePath: string) => editorRevealEntry(cell.rootDir, relativePath),
    [cell.rootDir],
  );


  /** Split right: the file opens again in a new Editor pane beside this one. */
  const splitTab = useCallback((tabId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (tab?.kind === "file") requestEditorSplit(cell.id, tab.filePath);
  }, [cell.id, tabs]);



  const stageFile = useCallback(async (filePath: string) => {
    if (!isTauri()) return;
    const dirtyBuffer = getEditorFileBuffer(filePath);
    if (dirtyBuffer?.dirty || (filePath === activeFilePath && activeDirty)) {
      const saved = await saveDirtyFile(filePath);
      if (!saved) return;
    }
    setGitError(null);
    try {
      await codespaceGitStageFileFor(location ?? null, filePath, { repoRoot: cell.rootDir });
      await refreshGitStatus();
    } catch (nextError) {
      setGitError(describeError(nextError));
    }
  }, [activeDirty, activeFilePath, cell.rootDir, location, refreshGitStatus, saveDirtyFile, setGitError]);

  const stageAll = useCallback(async () => {
    if (!isTauri()) return;
    const saved = await saveAllDirtyFiles();
    if (!saved) return;
    setGitError(null);
    try {
      await codespaceGitStageAllFor(location ?? null, { repoRoot: cell.rootDir });
      await refreshGitStatus();
    } catch (nextError) {
      setGitError(describeError(nextError));
    }
  }, [cell.rootDir, location, refreshGitStatus, saveAllDirtyFiles, setGitError]);

  const unstageFile = useCallback(async (filePath: string) => {
    if (!isTauri()) return;
    setGitError(null);
    try {
      await codespaceGitUnstageFileFor(location ?? null, filePath, { repoRoot: cell.rootDir });
      await refreshGitStatus();
    } catch (nextError) {
      setGitError(describeError(nextError));
    }
  }, [cell.rootDir, location, refreshGitStatus, setGitError]);

  const unstageAll = useCallback(async () => {
    if (!isTauri()) return;
    setGitError(null);
    try {
      await codespaceGitUnstageAllFor(location ?? null, { repoRoot: cell.rootDir });
      await refreshGitStatus();
    } catch (nextError) {
      setGitError(describeError(nextError));
    }
  }, [cell.rootDir, location, refreshGitStatus, setGitError]);


  const discardAllChanges = useCallback(async (rootDir: string) => {
    if (!isTauri()) return;

    setGitError(null);
    try {
      await codespaceGitDiscardAllChangesFor(location ?? null, { repoRoot: rootDir });
      await forgetLocalEdits((path) => isInsideRoot(rootDir, path));
      if (rootDir === cell.rootDir) await refreshGitStatus();
    } catch (nextError) {
      setGitError(describeError(nextError));
    }
  }, [cell.rootDir, forgetLocalEdits, location, refreshGitStatus, setGitError]);

  const discardFile = useCallback(async (rootDir: string, filePath: string) => {
    if (!isTauri()) return;

    setGitError(null);
    try {
      await codespaceGitDiscardFileFor(location ?? null, filePath, { repoRoot: rootDir });
      const target = normalizePath(filePath);
      await forgetLocalEdits((path) => normalizePath(path) === target);
      if (rootDir === cell.rootDir) await refreshGitStatus();
    } catch (nextError) {
      setGitError(describeError(nextError));
    }
  }, [cell.rootDir, forgetLocalEdits, location, refreshGitStatus, setGitError]);

  /** After a commit or push: the pane's own status and the repo's row, errors to the status bar. */
  const refreshRepoAfterAction = useCallback(async (rootDir: string) => {
    try {
      await Promise.all([rootDir === cell.rootDir ? refreshGitStatus() : null, multiGit.refreshRepo(rootDir)]);
    } catch (err) {
      setGitError(describeError(err));
    }
  }, [cell.rootDir, multiGit, refreshGitStatus, setGitError]);

  /**
   * A Source action in `rootDir`: `own` for the pane's repo (which refreshes the pane's status
   * itself), `other` for any other repo. The repo's row is read again either way.
   */
  const runInRepo = useCallback(async (rootDir: string, own: () => Promise<unknown>, other: () => Promise<unknown> = own) => {
    try {
      await (rootDir === cell.rootDir ? own() : other());
    } catch (err) {
      setGitError(describeError(err));
    }
    try {
      await multiGit.refreshRepo(rootDir);
    } catch (err) {
      setGitError(describeError(err));
    }
  }, [cell.rootDir, multiGit, setGitError]);

  /** The message Claude wrote for the staged changes, or null (the error goes to the status bar). */
  const aiSuggestCommitMessage = useCallback(async (rootDir: string): Promise<string | null> => {
    if (!isTauri()) return null;

    setGitError(null);
    try {
      return await codespaceGitAiSuggestCommitFor(location ?? null, { repoRoot: rootDir });
    } catch (nextError) {
      setGitError(describeError(nextError));
      return null;
    }
  }, [location, setGitError]);


  // Only the newest read lands: switching tab or side while one is in flight drops the older one.
  const diffReadIdRef = useRef(0);
  const refreshDiffPreview = useCallback(async (
    repoRoot: string,
    filePath: string,
    target: DiffTabTarget,
  ) => {
    if (!enabled) return;
    if (!isTauri()) return;

    const readId = ++diffReadIdRef.current;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const [nextDiff, nextFileDiff] = target === "disk"
        ? ["", await diskAgainstEdits(filePath)]
        : await Promise.all([
          codespaceGitDiffFileFor(location ?? null, filePath, target, { repoRoot }),
          codespaceGitDiffFileContentFor(location ?? null, filePath, target, { repoRoot }),
        ]);
      if (readId !== diffReadIdRef.current) return;
      setDiffContent(nextDiff);
      setDiffFileContent(nextFileDiff);
      setDiffLoadedKey(`${target}:${filePath}`);
    } catch (nextError) {
      if (readId !== diffReadIdRef.current) return;
      setDiffContent("");
      setDiffFileContent({
        original: "",
        modified: "",
        originalPath: "original://empty",
        modifiedPath: "modified://empty",
      });
      setDiffError(describeError(nextError));
      setDiffLoadedKey(null);
    } finally {
      if (readId === diffReadIdRef.current) setDiffLoading(false);
    }
  }, [diskAgainstEdits, enabled, location]);


  const viewFileDiff = useCallback(async (repoRoot: string, filePath: string, target: CodespaceGitDiffTarget) => {
    if (target === "unstaged") {
      const saved = await saveDirtyFile(filePath);
      if (!saved) return;
    }
    openDiffTab(filePath, target, repoRoot);
    setDiffReadRequest((value) => value + 1);
  }, [openDiffTab, saveDirtyFile]);

  const activeDiffPath = activeDiffTab?.filePath ?? null;
  const activeDiffTarget = activeDiffTab?.target ?? null;

  // Read again when the tab or its side changes, and after every git refresh of this file (a
  // stage, a commit or a save changes what the diff holds). Each refresh parses a new status row,
  // so the row's identity is the signal; the repo map would also change for other repos' refreshes.
  useEffect(() => {
    if (!activeDiffPath || !activeDiffTarget) return;
    void refreshDiffPreview(activeDiffRepoRoot, activeDiffPath, activeDiffTarget);
  }, [activeDiffPath, activeDiffRepoRoot, activeDiffStatus, activeDiffTarget, diffReadRequest, refreshDiffPreview]);

  // A side emptied by a stage or unstage gives way to the side that still has changes.
  useEffect(() => {
    if (!activeDiffTab || activeDiffTab.target === "disk" || activeDiffSides.length !== 1 || activeDiffSides[0] === activeDiffTab.target) return;
    openDiffTab(activeDiffTab.filePath, activeDiffSides[0], activeDiffTab.repoRoot);
  }, [activeDiffSides, activeDiffTab, openDiffTab]);

  useEffect(() => {
    if (!enabled) return;
    if (!activeFilePath) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      // Every Editor pane listens on the window; only the one holding focus saves. A terminal or
      // another pane keeps the key.
      if (!rootRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      void handleSave();
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeFilePath, enabled, handleSave]);

  useEffect(() => {
    setShowPreview(previewKind !== null);
  }, [previewKind]);

  const closeGoToFile = useCallback((options: { restoreFocus?: boolean } = {}) => {
    setGoToFileOpen(false);
    const previous = focusBeforeGoToFileRef.current;
    focusBeforeGoToFileRef.current = null;
    // A command that moves focus itself (Reveal in tree) keeps it.
    if (options.restoreFocus === false) return;
    // After the palette unmounts, or focus would fall to the page and ⌘P would stop answering.
    window.setTimeout(() => {
      if (previous?.isConnected) previous.focus();
      else rootRef.current?.focus();
    }, 0);
  }, []);

  const ensureFileIndex = useCallback((options: { force?: boolean } = {}) => {
    // One index per folder and machine, read again after a while so new files show up.
    if (!options.force && fileIndex && fileIndex.key === listingKey && !fileIndex.error && Date.now() - fileIndex.at < FILE_INDEX_MAX_AGE_MS) return;
    const key = listingKey;
    void editorIndexFilesFor(location ?? null, cell.rootDir)
      .then((index) => {
        if (listingKeyRef.current === key) setFileIndex({ key, files: index.files, truncated: index.truncated, at: Date.now(), error: null });
      })
      .catch((err) => {
        if (listingKeyRef.current === key) setFileIndex({ key, files: [], truncated: false, at: 0, error: describeError(err) });
      });
  }, [cell.rootDir, fileIndex, listingKey, location]);

  const openGoToFile = useCallback((initialQuery = "") => {
    if (!focusBeforeGoToFileRef.current && document.activeElement instanceof HTMLElement) {
      focusBeforeGoToFileRef.current = document.activeElement;
    }
    setGoToFileInitialQuery(initialQuery);
    setGoToFileOpen(true);
    ensureFileIndex();
  }, [ensureFileIndex]);

  // Recent files belong to this folder on this machine.
  useEffect(() => {
    setRecentFiles(listRecentFiles(listingKey));
  }, [listingKey]);

  useEffect(() => {
    if (!enabled || !activeFilePath) return;
    recordRecentFile(listingKey, activeFilePath);
    setRecentFiles(listRecentFiles(listingKey));
  }, [activeFilePath, enabled, listingKey]);

  // Deletes made here are forgotten at once, and a file that fails to open as missing is
  // forgotten then. The ⌘P index, when one was read, also drops files deleted elsewhere. The
  // launcher does not read the index itself: that walks the whole repo, over SSH too.
  const liveRecentFiles = useMemo(() => {
    const index = fileIndex && fileIndex.key === listingKey ? fileIndex : null;
    // Not read yet, unreadable, or cut short: it cannot say a file is gone.
    if (!index || index.error || index.truncated) return recentFiles;
    const present = new Set(index.files.map(normalizePath));
    return recentFiles.filter((entry) => present.has(normalizePath(entry.path)));
  }, [fileIndex, listingKey, recentFiles]);

  const showFilesSidebar = useCallback(() => {
    setWorkbenchSidebarCollapsed(false);
    setSidebarMode("files");
  }, [setWorkbenchSidebarCollapsed]);

  const startNewFile = useCallback(() => {
    showFilesSidebar();
    setTreeCreateRequest((previous) => ({ kind: "file", nonce: (previous?.nonce ?? 0) + 1 }));
  }, [showFilesSidebar]);

  const showSource = useCallback(() => {
    setWorkbenchSidebarCollapsed(false);
    setSidebarMode("source");
  }, [setWorkbenchSidebarCollapsed]);

  const showSearch = useCallback(() => {
    setWorkbenchSidebarCollapsed(false);
    setSidebarMode("search");
    setSearchFocusRequest((previous) => ({ nonce: (previous?.nonce ?? 0) + 1 }));
  }, [setWorkbenchSidebarCollapsed]);

  // Language servers: on in Settings, and only in a folder the user trusts (they run its code).
  const lspTrusted = isFolderTrusted(editorPreferences.trustedFolders, location ?? null, cell.rootDir);
  const lspPlace = useMemo(() => ({ location: location ?? null, rootDir: cell.rootDir }), [cell.rootDir, location]);
  const lspOptions = useMemo(
    () => ({ place: lspPlace, enabled: editorPreferences.languageServers, trusted: lspTrusted }),
    [editorPreferences.languageServers, lspPlace, lspTrusted],
  );
  const { status: lspStatus, problems: lspProblems } = useLspStatus(activeFilePath, lspPlace);
  const [trustAsked, setTrustAsked] = useState(false);
  const languageServersOn = editorPreferences.languageServers;
  useEffect(() => {
    if (!languageServersOn) void stopAllLsp();
  }, [languageServersOn]);
  useEffect(() => onLspNotice((notice) => setDiskNotice(notice.text)), [, setDiskNotice]);

  const trustFolder = useCallback(() => {
    updateEditorPreferences({ trustedFolders: [...editorPreferences.trustedFolders, trustKey(location ?? null, cell.rootDir)] });
  }, [cell.rootDir, editorPreferences.trustedFolders, location, updateEditorPreferences]);

  const handleLanguageServerClick = useCallback(() => {
    if (!lspStatus || !activeFilePath) return;
    switch (lspStatus.kind) {
      case "off":
        updateEditorPreferences({ languageServers: true });
        break;
      case "untrusted":
        setTrustAsked(false);
        break;
      case "missing":
        void copyTextToClipboard(lspStatus.installHint)
          .then(() => setDiskNotice(`Copied: ${lspStatus.installHint}`))
          .catch(() => setDiskNotice(`Install ${lspStatus.label} with: ${lspStatus.installHint}`));
        break;
      case "error":
        void restartLspForFile(activeFilePath);
        break;
      default:
        break;
    }
  }, [activeFilePath, lspStatus, updateEditorPreferences, setDiskNotice]);

  const openDefinition = useCallback((path: string, range: { startLine: number; startColumn: number; endLine: number; endColumn: number }) => {
    openFileTab(path);
    revealNonce += 1;
    setRevealRequest({
      path,
      startLine: range.startLine,
      endLine: range.endLine,
      ...(range.startLine === range.endLine ? { startColumn: range.startColumn, endColumn: range.endColumn } : {}),
      nonce: revealNonce,
    });
  }, [openFileTab]);

  const loadMarkdownFile = useCallback((path: string) => readEditorFileBytes(path, editorIoContext), [editorIoContext]);

  const openSearchMatch = useCallback((path: string, match: EditorSearchMatch) => {
    openFileTab(path);
    revealNonce += 1;
    setRevealRequest({
      path,
      startLine: match.line,
      endLine: match.line,
      startColumn: match.column,
      endColumn: match.column + match.length,
      nonce: revealNonce,
    });
  }, [openFileTab]);

  // ⌘N is the app's New window, and ⇧⌘G is the editor's Find previous, so these follow VS Code.
  const launcherActions = useMemo<LauncherAction[]>(() => [
    { id: "new-file", label: "New file", keys: "⌥⌘N", icon: FilePlus, run: startNewFile },
    { id: "search", label: "Find in files", keys: "⇧⌘F", icon: Search, run: showSearch },
    { id: "source", label: "Source", keys: "⌃⇧G", icon: GitBranch, run: showSource },
  ], [showSearch, showSource, startNewFile]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!rootRef.current?.contains(document.activeElement)) return;
      const primary = hasPrimaryModifier(event);
      // `code`, not `key`: with ⌥ held a Mac keyboard types "˜" for N.
      const newFile = event.code === "KeyN" && event.altKey && !event.shiftKey && primary;
      const source = event.code === "KeyG" && event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
      const search = event.code === "KeyF" && event.shiftKey && !event.altKey && primary;
      if (!newFile && !source && !search) return;
      event.preventDefault();
      if (newFile) startNewFile();
      else if (search) showSearch();
      else showSource();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [enabled, showSearch, showSource, startNewFile]);

  // `>` in the palette.
  const paletteCommands = useMemo<PaletteCommand[]>(() => [
    { id: "save-all", label: "Save all", run: () => void saveAllDirtyFiles() },
    { id: "find-in-files", label: "Find in files", run: showSearch },
    ...(lspStatus?.kind === "untrusted" ? [{ id: "lsp-trust", label: "Trust this folder (language servers)", run: trustFolder }] : []),
    ...(lspStatus && activeFilePath && lspStatus.kind !== "off" && lspStatus.kind !== "untrusted" && lspStatus.kind !== "missing"
      ? [{ id: "lsp-restart", label: `Restart ${lspStatus.label}`, run: () => void restartLspForFile(activeFilePath) }]
      : []),
    {
      id: "lsp-toggle",
      label: languageServersOn ? "Turn language servers off" : "Turn language servers on",
      run: () => updateEditorPreferences({ languageServers: !languageServersOn }),
    },
    ...(activeFilePath
      ? [
        { id: "toggle-word-wrap", label: wordWrap ? "Turn word wrap off" : "Turn word wrap on", run: () => updateEditorPreferences({ wordWrap: !wordWrap }) },
        ...EDITOR_TOGGLE_COMMANDS.map(({ preference, name }) => ({
          id: `toggle-${preference}`,
          label: `Turn ${name} ${editorPreferences[preference] ? "off" : "on"}`,
          run: () => updateEditorPreferences({ [preference]: !editorPreferences[preference] }),
        })),
        ...EDITOR_AUTO_SAVE_OPTIONS.filter((option) => option.value !== editorPreferences.autoSave).map((option) => ({
          id: `auto-save-${option.value}`,
          label: option.value === "off" ? "Turn auto save off" : `Auto save: ${option.label.toLowerCase()}`,
          run: () => updateEditorPreferences({ autoSave: option.value }),
        })),
        { id: "font-bigger", label: `Increase font size (${editorFontSize}px)`, run: () => updateEditorPreferences({ fontSize: stepEditorFontSize(editorFontSize, 1) }) },
        { id: "font-smaller", label: `Decrease font size (${editorFontSize}px)`, run: () => updateEditorPreferences({ fontSize: stepEditorFontSize(editorFontSize, -1) }) },
        ...(editorFontSize !== DEFAULT_EDITOR_FONT_SIZE
          ? [{ id: "font-reset", label: `Reset font size (${DEFAULT_EDITOR_FONT_SIZE}px)`, run: () => updateEditorPreferences({ fontSize: DEFAULT_EDITOR_FONT_SIZE }) }]
          : []),
        {
          id: "reveal-in-tree",
          label: "Reveal in tree",
          run: () => {
            showFilesSidebar();
            setTreeRevealRequest((value) => value + 1);
          },
        },
      ]
      : []),
  ], [activeFilePath, editorFontSize, editorPreferences, languageServersOn, lspStatus, saveAllDirtyFiles, showFilesSidebar, showSearch, trustFolder, updateEditorPreferences, wordWrap]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      // ⌘P on a Mac, where Ctrl+P is the editor's "cursor up"; Ctrl+P elsewhere.
      if (!isPrimaryChord(event) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "p") return;
      if (!rootRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      openGoToFile();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [enabled, openGoToFile]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!isPrimaryChord(event) || !event.shiftKey || event.altKey || event.code !== "KeyT") return;
      if (!rootRef.current?.contains(document.activeElement)) return;
      if (!canReopenTab()) return;
      // Capture phase on window: stopping here keeps Code mode's ⌘⇧T (new Thread) from firing too.
      event.preventDefault();
      event.stopPropagation();
      void reopenClosedTab();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [enabled, reopenClosedTab, tabs, canReopenTab]);

  // ⌃1–⌃8 (Alt elsewhere) jumps to that tab, ⌃9 to the last; ⌘1–9 stays the workspace's pane jump.
  // ⌘\ splits the active file into a new Editor pane beside, as VS Code's Split Editor.
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!rootRef.current?.contains(document.activeElement)) return;
      const index = tabIndexShortcut(event);
      if (index !== null) {
        const tab = index === "last" ? tabs.at(-1) : tabs[index];
        if (!tab) return;
        event.preventDefault();
        event.stopPropagation();
        commitTabs(tabs, tab.id);
        return;
      }
      if (isPrimaryChord(event) && !event.shiftKey && !event.altKey && event.code === "Backslash" && activeFilePath) {
        if (!requestEditorSplit(cell.id, activeFilePath)) return;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeFilePath, cell.id, commitTabs, enabled, tabs]);


  /*
   * ⌘L, the selection popover and the tree's "Send to Thread". This pane only builds the text and
   * names itself; which agent receives it is the surface's decision (`selection-send.ts`). The
   * text is put in a composer and focused there, never sent.
   */
  const handOn = useCallback((action: SelectionAction, payload: string, pathRange: string) => {
    if (action === "copy") {
      void copyTextToClipboard(pathRange)
        .then(() => setDiskNotice(`Copied ${pathRange}`))
        .catch((err: unknown) => setDiskNotice(describeError(err)));
      return;
    }
    const result = sendSelectionToAgent(cell.id, action === "ask" ? withAskAboutLine(payload) : payload);
    if (!result.ok) setDiskNotice(result.reason);
  }, [cell.id, setDiskNotice]);

  const handleEditorSelection = useCallback((action: SelectionAction, selection: EditorLineSelection) => {
    if (!activeFilePath) return;
    const shownPath = makeRelativePath(cell.rootDir, activeFilePath);
    handOn(
      action,
      buildCodeSelectionPayload({ ...selection, path: shownPath, language: resolveEditorLanguage(activeFilePath) }),
      formatPathRange(shownPath, selection.startLine, selection.endLine),
    );
  }, [activeFilePath, cell.rootDir, handOn]);

  const handleDiffSelection = useCallback((action: SelectionAction, selection: DiffEditorSelection, filePath: string) => {
    const shownPath = makeRelativePath(cell.rootDir, filePath);
    handOn(
      action,
      buildDiffSelectionPayload({
        path: shownPath,
        side: selection.side,
        startLine: selection.startLine,
        endLine: selection.endLine,
        original: selection.original,
        modified: selection.modified,
        changes: selection.changes,
        selectedCode: selection.code,
        language: resolveEditorLanguage(filePath),
      }),
      formatPathRange(shownPath, selection.startLine, selection.endLine),
    );
  }, [cell.rootDir, handOn]);

  const sendTreeEntryToThread = useCallback((relativePath: string, kind: "file" | "directory") => {
    const payload = buildPathPayload(relativePath, kind);
    handOn("send", payload, payload);
  }, [handOn]);


  // The text on screen is the buffer's: typing updates the buffer without a render (see
  // `handleEditorChange`), so `content` is only what was last pushed in from outside.
  const activeBuffer = activeFilePath ? getEditorFileBuffer(activeFilePath) : null;
  const shownContent = activeBuffer && loadedPath === activeFilePath ? activeBuffer.content : content;
  const blame = useInlineBlame({
    on: editorPreferences.inlineBlame && !isSshWorkspace && gitAvailable && !binary,
    rootDir: cell.rootDir,
    filePath: loadedPath === activeFilePath ? activeFilePath : null,
    savedText: activeBuffer?.savedContent ?? (activeDirty || loading ? null : shownContent),
  });
  const statusBlameEntry = blame && editorStatus && !activeDirty ? blameAt(blame.entries, editorStatus.line) : null;
  const activeTooLarge = activeFilePath && activeBuffer?.tooLarge
    ? {
      sizeBytes: activeBuffer.sizeBytes,
      onOpenAnyway: activeBuffer.sizeBytes <= EDITOR_LARGE_FILE_LIMIT_BYTES
        ? () => void openLargeFile(activeFilePath)
        : null,
    }
    : null;

  const unsavedPathsInRoot = getEditorFileBuffers()
    .filter((buffer) => buffer.dirty && isInsideRoot(cell.rootDir, buffer.path))
    .map((buffer) => buffer.path);
  // The breadcrumb carries the file's own actions; this bar only brings the sidebar back.
  const showEditorBar = sidebarCollapsed;
  const showBreadcrumb = Boolean(activeFilePath);
  // On the file's own tab, and on its compare, so the choice can be made from either.
  const bannerPath = activeFilePath ?? (activeDiffTab?.target === "disk" ? activeDiffTab.filePath : null);
  const conflictPath = bannerPath && diskConflicts.has(bannerPath) ? bannerPath : null;

  return (
    <div ref={rootRef} tabIndex={-1} className="codespace-panel-surface outline-none relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="codespace-workbench-layout flex min-h-0 flex-1">
        {!sidebarCollapsed ? (
          <aside
            className="codespace-workbench-sidebar group/sidebar relative shrink-0"
            style={{ width: sidebarWidthLocal }}
          >
            <div className="flex h-full min-h-0 flex-col">
              {/* Two views of one folder, as a quiet segmented switch; the sidebar's own action at the right. */}
              <div className="scm-sidebar-bar">
                <div className="scm-sidebar-tabs" role="group" aria-label="Sidebar view">
                  <button
                    type="button"
                    aria-pressed={sidebarMode === "files"}
                    onClick={() => setSidebarMode("files")}
                    className={cn("scm-sidebar-tab", sidebarMode === "files" && "is-active")}
                    title="Files"
                  >
                    <Files className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">Files</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={sidebarMode === "search"}
                    onClick={showSearch}
                    className={cn("scm-sidebar-tab", sidebarMode === "search" && "is-active")}
                    title={`Find in files (${shortcut("⇧⌘F")})`}
                  >
                    <Search className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">Search</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={sidebarMode === "source"}
                    onClick={() => setSidebarMode("source")}
                    className={cn("scm-sidebar-tab", sidebarMode === "source" && "is-active")}
                    title={`Source control (${shortcut("⌃⇧G")})`}
                  >
                    <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">Source</span>
                    {hasSourceChanges ? <span className="scm-sidebar-count">{sourceChangeCount}</span> : null}
                  </button>
                  <button
                    type="button"
                    aria-pressed={sidebarMode === "graph"}
                    onClick={showGraph}
                    className={cn("scm-sidebar-tab", sidebarMode === "graph" && "is-active")}
                    title="Git graph"
                  >
                    <GitGraph className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">Graph</span>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setWorkbenchSidebarCollapsed(true)}
                  className="codespace-workbench-toolbar-button scm-sidebar-hide"
                  aria-label="Hide sidebar"
                  title="Hide sidebar"
                >
                  <PanelLeftClose className="h-3 w-3" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {/* Source stays mounted under Files: a commit or push running there keeps its spinner,
                    its lock and its result. */}
                {sidebarMode === "files" ? (
                  <>
                    {entriesError && availableEntries.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-amber-300/80">
                        {entriesError}
                      </div>
                    ) : null}
                    <FileTree
                      rootDir={cell.rootDir}
                      entries={availableEntries}
                      activeFilePath={activeFilePath}
                      gitStatusByPath={gitStatusByPath}
                      onStageFile={(filePath) => void stageFile(filePath)}
                      onUnstageFile={(filePath) => void unstageFile(filePath)}
                      unsavedPaths={unsavedPathsInRoot}
                      loadedDirectories={loadedDirectories}
                      loadingDirectories={loadingDirectories}
                      truncatedDirectories={truncatedDirectories}
                      // No loader while the pane is off: the tree would mark folders as asked for
                      // and wait for listings that never come.
                      onLoadDirectory={enabled ? (directory) => void loadDirectory(directory) : undefined}
                      // The tree filter searches the same index as ⌘P: a lazy tree has only read the
                      // folders you opened. Until it is read (or if it cannot be), the loaded rows.
                      onSearchStart={() => ensureFileIndex()}
                      searchFiles={fileIndex && fileIndex.key === listingKey && !fileIndex.error ? fileIndex.files : null}
                      // Neither list covers every file, so no count is better than a wrong one.
                      fileCount={null}
                      onCreateFile={createFile}
                      onCreateFolder={createFolder}
                      onDeleteEntry={deleteEntry}
                      onRenameEntry={renameEntry}
                      onRevealEntry={isSshWorkspace ? undefined : revealEntry}
                      onSendEntryToThread={sendTreeEntryToThread}
                      onRefresh={() => {
                        refreshGitStatusForVisibleView();
                        if (fileIndex) ensureFileIndex({ force: true });
                        return refreshEntries({ force: true });
                      }}
                      onOpenFile={openFileTab}
                      createRequest={treeCreateRequest}
                      revealActiveRequest={treeRevealRequest}
                    />
                  </>
                ) : null}
                {/* Search mounts when first opened, then stays: its query and results wait while
                    you read a match. */}
                {searchOpened ? (
                  <div className={sidebarMode === "search" ? "h-full" : "hidden"}>
                    <SearchPanel
                      searchId={`workbench:${cell.id}`}
                      rootDir={cell.rootDir}
                      location={location ?? null}
                      onOpenMatch={openSearchMatch}
                      focusRequest={searchFocusRequest}
                    />
                  </div>
                ) : null}
                {graphOpened ? (
                  <div className={sidebarMode === "graph" ? "h-full" : "hidden"}>
                    {isSshWorkspace ? (
                      <div className="gg-state">
                        <b>Not available for remote workspaces yet.</b>
                        The Git graph reads git on this computer only.
                      </div>
                    ) : (
                      <GitGraphView
                        repoRoot={graphRepoRoot}
                        repos={graphRepos}
                        onRepoChange={setGraphRepoPicked}
                        enabled={enabled && sidebarMode === "graph" && !sidebarCollapsed}
                        uncommitted={graphUncommitted}
                        onShowUncommitted={() => setSidebarMode("source")}
                        onOpenCommit={(sha, subject) => openCommitTab(graphRepoRoot, sha, subject)}
                        onOpenWide={() => openGraphTab(graphRepoRoot)}
                        openSha={activeTab?.kind === "commit" ? activeTab.sha : null}
                      />
                    )}
                  </div>
                ) : null}
                <div className={sidebarMode === "source" ? "h-full" : "hidden"}>
                  <SourceControlPanel
                    repos={multiGit.repos.size > 0
                      ? multiGit.repos
                      : new Map([[cell.rootDir, {
                          rootDir: cell.rootDir,
                          statuses: gitStatuses,
                          summary: gitSummary,
                          available: gitAvailable,
                          loading: gitLoading,
                          error: gitError,
                        }]])}
                    onRefreshRepo={(rootDir) => {
                      if (rootDir === cell.rootDir) void refreshGitStatus();
                      void multiGit.refreshRepo(rootDir);
                    }}
                    // Each returns its promise, so the panel shows the action as running until it ends.
                    onStageFile={(rootDir, filePath) => runInRepo(rootDir,
                      () => stageFile(filePath),
                      () => codespaceGitStageFileFor(location ?? null, filePath, { repoRoot: rootDir }))}
                    onUnstageFile={(rootDir, filePath) => runInRepo(rootDir,
                      () => unstageFile(filePath),
                      () => codespaceGitUnstageFileFor(location ?? null, filePath, { repoRoot: rootDir }))}
                    onStageAll={(rootDir) => runInRepo(rootDir,
                      () => stageAll(),
                      () => codespaceGitStageAllFor(location ?? null, { repoRoot: rootDir }))}
                    onUnstageAll={(rootDir) => runInRepo(rootDir,
                      () => unstageAll(),
                      () => codespaceGitUnstageAllFor(location ?? null, { repoRoot: rootDir }))}
                    onDiscardAllChanges={(rootDir) => runInRepo(rootDir, () => discardAllChanges(rootDir))}
                    onDiscardFile={(rootDir, filePath) => runInRepo(rootDir, () => discardFile(rootDir, filePath))}
                    onCommit={async (rootDir, message) => {
                      try {
                        await codespaceGitCommitFor(location ?? null, message, { repoRoot: rootDir });
                      } catch (err) {
                        setGitError(describeError(err));
                        return false;
                      }
                      // Landed: a refresh that fails after it does not make it a failed commit.
                      await refreshRepoAfterAction(rootDir);
                      return true;
                    }}
                    onPush={async (rootDir) => {
                      try {
                        await codespaceGitPushFor(location ?? null, { repoRoot: rootDir });
                      } catch (err) {
                        setGitError(describeError(err));
                        return;
                      }
                      await refreshRepoAfterAction(rootDir);
                    }}
                    onAiSuggestCommit={aiSuggestCommitMessage}
                    onActivityChange={setGitActivity}
                    onViewDiff={(rootDir, filePath, target) => void viewFileDiff(rootDir, filePath, target)}
                  />
                </div>
              </div>
            </div>
            <div
              className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize transition-colors group-hover/sidebar:bg-white/[0.04] hover:bg-blue-400/30"
              onMouseDown={handleResizeMouseDown}
              aria-hidden="true"
            />
          </aside>
        ) : null}
        <main className="codespace-workbench-main flex min-w-0 flex-1 flex-col">
          {showEditorBar ? (
            <div className="codespace-workbench-editorbar flex h-7 shrink-0 items-center gap-2 border-b px-2.5">
              {sidebarCollapsed ? (
                <button
                  type="button"
                  className="codespace-workbench-toolbar-button"
                  aria-label="Show sidebar"
                  title="Show sidebar"
                  onClick={() => setWorkbenchSidebarCollapsed(false)}
                >
                  <PanelLeftOpen className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          ) : null}
          {tabs.length > 0 ? (
            <WorkbenchTabBar
              tabs={tabs}
              activeTabId={activeTabId}
              onSelectTab={(tabId) => commitTabs(tabs, tabId)}
              onCloseTab={closeTab}
              onCloseTabs={closeTabsInScope}
              onNewUrlTab={addUrlTab}
              onKeepTab={keepPreviewTab}
              onPinTab={pinTab}
              onMoveTab={reorderTab}
              onSplitTab={splitTab}
              canSplit={() => canSplitEditor(cell.id)}
              allowUrlTabs={allowUrlTabs}
              allowNewUrlTabs={false}
              deletedPaths={deletedFiles}
              trailing={(
                <button
                  type="button"
                  onClick={() => openGoToFile()}
                  className="flex items-center gap-2 rounded-[6px] border border-[color:var(--codespace-panel-border)] px-2 py-1 text-[11.5px] text-[color:var(--codespace-panel-text-muted)] hover:bg-[color:var(--codespace-panel-surface-hover)]"
                  title={`Go to file (${shortcut("⌘P")})`}
                >
                  <Search className="h-3 w-3" aria-hidden="true" />
                  Go to file
                  <kbd className="rounded-[4px] bg-[color:var(--codespace-panel-surface-active)] px-1 font-mono text-[11px]">{shortcut("⌘P")}</kbd>
                </button>
              )}
            />
          ) : null}
          {showBreadcrumb && activeFilePath ? (
            <WorkbenchBreadcrumb
              // A list open for the last file closes with it.
              key={`breadcrumb:${activeFilePath}`}
              rootDir={cell.rootDir}
              filePath={activeFilePath}
              listDirectory={(directory) => editorListDirectoryFor(location ?? null, directory, { cache: true })}
              onOpenFile={openFileTab}
              wordWrap={wordWrap}
              onToggleWordWrap={() => updateEditorPreferences({ wordWrap: !wordWrap })}
              trailing={previewKind ? (
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className={cn(
                    "codespace-workbench-toolbar-button",
                    showPreview && "codespace-workbench-toolbar-button--preview-on",
                  )}
                  aria-label={showPreview ? "Show editor" : previewKind === "svg" ? "Preview image" : "Preview markdown"}
                  title={showPreview ? "Back to editor" : "Preview"}
                >
                  {showPreview
                    ? <EyeOff className="h-3.5 w-3.5" />
                    : <Eye className="h-3.5 w-3.5" />}
                </button>
              ) : null}
            />
          ) : null}
          {conflictPath ? (
            <WorkbenchConflictBanner
              fileName={fileName(conflictPath)}
              onCompare={() => openDiffTab(conflictPath, "disk")}
              onReload={() => void reloadFromDisk(conflictPath)}
              onOverwrite={() => void overwriteDisk(conflictPath)}
            />
          ) : null}
          {lspStatus?.kind === "untrusted" && !trustAsked ? (
            <WorkbenchTrustBanner
              serverLabel={lspStatus.label}
              folderName={fileName(cell.rootDir) || cell.rootDir}
              onTrust={trustFolder}
              onDismiss={() => setTrustAsked(true)}
            />
          ) : null}
          {activeTab?.kind === "url"
            ? <WorkbenchBrowserTab url={activeUrl} webviewLabel={activeWebviewLabel} enabled={enabled} />
            : activeTab?.kind === "commit"
              ? (
                <GitCommitView
                  key={activeTab.id}
                  repoRoot={activeTab.repoRoot}
                  sha={activeTab.sha}
                  fontSize={editorFontSize}
                  onOpenCommit={(sha) => openCommitTab(activeTab.repoRoot, sha)}
                  onOpenFile={(path) => openFileTab(`${activeTab.repoRoot.replace(/[\\/]+$/, "")}/${path}`)}
                />
              )
            : activeTab?.kind === "graph"
              ? (
                <GitGraphView
                  key={activeTab.id}
                  repoRoot={activeTab.repoRoot}
                  wide
                  enabled={enabled}
                  uncommitted={multiGit.repos.get(activeTab.repoRoot)?.statuses.length ?? 0}
                  onShowUncommitted={showSource}
                  onOpenCommit={(sha, subject) => openCommitTab(activeTab.repoRoot, sha, subject)}
                />
              )
            : activeDiffTab
              ? (
                <WorkbenchDiffTab
                  filePath={activeDiffTab.filePath}
                  displayPath={makeRelativePath(cell.rootDir, activeDiffTab.filePath)}
                  target={activeDiffTab.target}
                  sides={activeDiffSides}
                  onTargetChange={(target) => openDiffTab(activeDiffTab.filePath, target, activeDiffTab.repoRoot)}
                  manualLayout={manualDiffLayout}
                  onLayoutChange={setManualDiffLayout}
                  onOpenFile={() => openFileTab(activeDiffTab.filePath)}
                  content={diffContent}
                  fileContent={diffFileContent}
                  loading={diffLoading && diffLoadedKey !== `${activeDiffTab.target}:${activeDiffTab.filePath}`}
                  error={diffError}
                  fontSize={editorFontSize}
                  onSelectionAction={(action, selection) => handleDiffSelection(action, selection, activeDiffTab.filePath)}
                />
              )
            : !activeTab
              ? (
                <WorkbenchLauncher
                  rootDir={cell.rootDir}
                  recent={liveRecentFiles}
                  actions={launcherActions}
                  onGoToFile={openGoToFile}
                  onOpen={openFileTab}
                />
              )
            : activeMedia && activeFilePath && !activeMedia.textual && binary && !loading && !error
              ? (
                <WorkbenchMediaPreview
                  key={`media:${activeFilePath}`}
                  fileName={fileName(activeFilePath)}
                  media={activeMedia}
                  source={{
                    kind: "bytes",
                    load: () => readEditorFileBytes(activeFilePath, editorIoContext),
                    version: mediaVersion,
                  }}
                />
              )
            : showPreview && previewKind === "svg" && activeMedia && activeFilePath && !loading && !error && !binary
              ? (
                <WorkbenchMediaPreview
                  key={`media:${activeFilePath}`}
                  fileName={fileName(activeFilePath)}
                  media={activeMedia}
                  source={{ kind: "text", text: shownContent }}
                />
              )
            : showPreview && previewKind === "markdown" && !loading && !error && !binary
              ? (
                <WorkbenchMarkdownPreview
                  content={shownContent}
                  filePath={activeFilePath}
                  rootDir={cell.rootDir}
                  loadFile={loadMarkdownFile}
                  onOpenFile={openFileTab}
                />
              )
              : (
                <WorkbenchEditor
                  filePath={activeFilePath}
                  content={shownContent}
                  loading={loading}
                  binary={binary}
                  tooLarge={activeTooLarge}
                  error={error}
                  dirty={activeDirty}
                  onChange={handleEditorChange}
                  onSave={() => void handleSave()}
                  contentPath={loadedPath}
                  wordWrap={wordWrap}
                  fontSize={editorFontSize}
                  onStatusChange={setEditorStatus}
                  rootDir={cell.rootDir}
                  onSelectionAction={handleEditorSelection}
                  onBlur={handleEditorBlur}
                  onEditorReady={(api) => {
                    editorApiRef.current = api;
                  }}
                  lsp={lspOptions}
                  onOpenLocation={openDefinition}
                  minimap={editorPreferences.minimap}
                  stickyScroll={editorPreferences.stickyScroll}
                  editorConfig={activeEditorConfig}
                  gitBaseline={gitAvailable ? activeGitBaseline : null}
                  blame={blame}
                  revealRange={
                    // Only once this file's own content is in: the tab switch lands a render
                    // before the load starts, while the previous file's text is still showing.
                    revealRequest && revealRequest.path === activeFilePath && loadedPath === activeFilePath && !loading
                      ? revealRequest
                      : null
                  }
                />
              )}
          {diskNotice ? <div aria-live="polite" className="codespace-disk-notice">{diskNotice}</div> : null}
          {/* Nothing open: the launcher says it all; the line stays for an error worth reading. */}
          {activeTab || saveError || gitError || gitActivity ? (
            <WorkbenchStatusBar
              dirty={activeDirty}
              status={activeFilePath ? editorStatus : null}
              git={gitSummary}
              blame={statusBlameEntry ? blameStatus(statusBlameEntry, Date.now()) : null}
              onBlameClick={statusBlameEntry?.committed && !isSshWorkspace
                ? () => openCommitTab(cell.rootDir, statusBlameEntry.commit, statusBlameEntry.summary)
                : undefined}
              language={!activeFilePath
                ? null
                : activeMedia && (binary || (previewKind === "svg" && showPreview))
                  ? activeMedia.label
                  : activeLanguage}
              encoding={activeBuffer?.encoding ?? null}
              notice={saveError ? `Save failed: ${saveError}` : gitError}
              activity={gitActivity}
              languageServer={activeFilePath && !binary ? lspStatus : null}
              problems={lspProblems}
              onLanguageServerClick={handleLanguageServerClick}
              onProblemsClick={() => editorApiRef.current?.showNextProblem()}
              onEndOfLineClick={() => editorApiRef.current?.setEndOfLine(editorStatus?.eol === "CRLF" ? "LF" : "CRLF")}
            />
          ) : null}
        </main>
      </div>
      {goToFileOpen ? (
        <GoToFilePalette
          rootDir={cell.rootDir}
          files={fileIndex && fileIndex.key === listingKey ? fileIndex.files : null}
          truncated={Boolean(fileIndex?.truncated)}
          error={fileIndex && fileIndex.key === listingKey ? fileIndex.error : null}
          recent={liveRecentFiles}
          commands={paletteCommands}
          initialQuery={goToFileInitialQuery}
          onCommand={(command) => {
            closeGoToFile({ restoreFocus: command.id !== "reveal-in-tree" });
            command.run();
          }}
          onClose={() => closeGoToFile()}
          onOpen={(path, line) => {
            closeGoToFile();
            requestWorkbenchOpen(cell.id, line ? { path, startLine: line, endLine: line } : { path });
          }}
        />
      ) : null}
      {pendingClose ? (
        <UnsavedChangesDialog
          paths={pendingClose.paths}
          rootDir={cell.rootDir}
          busy={pendingClose.busy}
          error={pendingClose.error}
          onSave={() => void savePendingClose()}
          onDiscard={() => {
            setPendingClose(null);
            closeTabsNow(pendingClose.tabIds, pendingClose.preferredActiveId);
          }}
          onCancel={() => setPendingClose(null)}
        />
      ) : null}
    </div>
  );
}
