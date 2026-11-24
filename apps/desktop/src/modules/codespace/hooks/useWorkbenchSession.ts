"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isTauri,
  type CodespaceGitFileDiffContent,
  type CodespaceGitFileStatus,
  type CodespaceGitRepoSummary,
} from "@/lib/tauri-api";
import {
  codespaceGitDiffFileContentFor,
  codespaceGitRepoSummaryFor,
  codespaceGitStatusFor,
  type CodeSpaceStoredWorkspaceLocation,
} from "@/lib/tauri/codespace";
import { watchEditorRoot, type EditorFsChange } from "@/lib/tauri/editor-watch";
import type { DiffTabTarget, WorkbenchTab } from "@/modules/codespace/components/types";
import type { WorkbenchEditorApi } from "@/modules/codespace/components/workbench/WorkbenchEditor";
import { clearEditorConfigCache, loadEditorConfig, type EditorConfig } from "@/modules/codespace/services/editor-config";
import { resolveSaveTidy } from "@/modules/codespace/services/editor-save-tidy";
import {
  closeTabsInList,
  hasReopenCandidate,
  keepTab,
  moveTab,
  openDiffInTabs,
  openFileInTabs,
  popReopenableFile,
  pushClosedFiles,
  setTabPinned,
  tabsInCloseScope,
  type TabCloseScope,
} from "@/modules/codespace/services/workbench-tab-state";
import { resolveEditorLanguage } from "@/modules/codespace/services/editor-languages";
import { buildCodeSpaceWebviewLabel, destroyWebviewPane } from "@/modules/codespace/services/webview-registry";
import {
  applyDiskFile,
  allowLargeEditorFile,
  clearEditorFileBuffer,
  getEditorFileBuffer,
  getEditorFileBuffers,
  heldByAnotherPane,
  isMissingEditorFileError,
  isSaveConflict,
  markEditorFileDeleted,
  readDiskFile,
  readEditorFile,
  releaseEditorFileBuffer,
  reloadEditorFile,
  saveEditorFile,
  setEditorFileHolder,
  updateEditorFileBuffer,
} from "@/modules/codespace/services/editor-file-store";
import { saveUnsavedFiles, unsavedFilePaths } from "@/modules/codespace/services/unsaved-changes";
import { openEditorFile, restoreEditorBackup } from "@/modules/codespace/services/editor-backups";
import {
  EDITOR_AUTO_SAVE_DELAY_MS,
  type EditorAutoSave,
  type EditorPreferences,
} from "@/modules/codespace/services/editor-preferences";
import { describeError, fileName, isInsideRoot, normalizePath, openFilePaths } from "@/modules/codespace/services/workbench-paths";

export interface WorkbenchSessionInput {
  /** Names this session to the shared buffer store and the watcher; two holders on a path share its buffer. */
  holderId: string;
  /** `kind === "ssh"` routes through the `*_ssh` commands; local (or none) keeps the local path. */
  location: CodeSpaceStoredWorkspaceLocation | null | undefined;
  rootDir: string;
  /** Off: nothing is read, watched or saved. Switching it back on keeps what was loaded. */
  enabled: boolean;
  initialTabs?: WorkbenchTab[];
  initialActiveTabId?: string | null;
  allowUrlTabs?: boolean;
  /** The pane's editor preferences (auto save, save steps). The caller owns them, so a change shows at once. */
  preferences: EditorPreferences;
  /** Whether git status should be read now. SSH has no watcher, so the cell reads it only while Source shows. */
  gitVisible?: boolean;
  /** The tab list moved: `activeTabId` is present only when the active tab was part of the change. */
  onTabsChange?: (patch: { tabs: WorkbenchTab[]; activeTabId?: string | null }) => void;
  /** An open file failed to load because it is gone. */
  onFileMissing?: (path: string) => void;
  /** After the session has synced its own tabs from a watcher event. */
  onDiskChange?: (change: EditorFsChange) => void;
}

type PendingClose = {
  tabIds: string[];
  paths: string[];
  preferredActiveId?: string;
  busy: boolean;
  error: string | null;
};

function getActiveTab(tabs: WorkbenchTab[], activeTabId: string | null): WorkbenchTab | null {
  return tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
}

/**
 * The editing session behind a Workbench: tabs, the buffer shown, dirty tracking, save and auto
 * save, the disk watch and its conflict state, git status with the shown file's baseline, and
 * crash-backup restore. Module-neutral: CodeSpace's Workbench cell and the canvas Code dock both
 * render on it. The file tree, search and Source panels stay with their surface.
 */
export function useWorkbenchSession({
  holderId,
  location,
  rootDir,
  enabled,
  initialTabs = [],
  initialActiveTabId = null,
  allowUrlTabs = true,
  preferences,
  gitVisible = true,
  onTabsChange,
  onFileMissing,
  onDiskChange,
}: WorkbenchSessionInput) {
  const [tabs, setTabs] = useState<WorkbenchTab[]>(initialTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initialActiveTabId);
  // The newest list, ahead of the render: code that resumes after an await (a save that marked a
  // tab clean) must build on it, not on the list its closure saw.
  const tabsRef = useRef(tabs);
  // Tell the buffer store which files this session has open, so another pane closing its tab on
  // the same file leaves this one's edits alone.
  useEffect(() => {
    setEditorFileHolder(holderId, openFilePaths(tabs));
  }, [holderId, tabs]);

  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState("");
  const [binary, setBinary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A save that failed for any other reason, shown in the status bar.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  // "a.ts updated on disk": a file taken from disk by itself, shown for a moment.
  const [diskNotice, setDiskNotice] = useState<string | null>(null);
  // Bumped when a binary file open in the media viewer changes on disk: it reads the bytes again.
  const [mediaVersion, setMediaVersion] = useState(0);
  // Files whose save was refused because they changed on disk: each shows the banner until a
  // choice is made, or its tab closes.
  const [diskConflicts, setDiskConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const updateDiskConflicts = useCallback((update: (paths: string[]) => string[]) => {
    setDiskConflicts((current) => {
      const next = update([...current]);
      return next.length === current.size && next.every((path) => current.has(path)) ? current : new Set(next);
    });
  }, []);
  const addDiskConflict = useCallback((path: string) => updateDiskConflicts((paths) => [...paths, path]), [updateDiskConflicts]);
  const endDiskConflicts = useCallback((ended: (path: string) => boolean) => {
    updateDiskConflicts((paths) => paths.filter((path) => !ended(path)));
  }, [updateDiskConflicts]);
  // Open files that were deleted on disk: their tabs are struck through until a save puts them
  // back or they reappear.
  const [deletedFiles, setDeletedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const setFileDeleted = useCallback((path: string, deleted: boolean) => {
    setDeletedFiles((current) => {
      if (current.has(path) === deleted) return current;
      const next = new Set(current);
      if (deleted) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const [gitStatuses, setGitStatuses] = useState<CodespaceGitFileStatus[]>([]);
  const [gitSummary, setGitSummary] = useState<CodespaceGitRepoSummary | null>(null);
  const [gitAvailable, setGitAvailable] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
  // Newest last; this session's only, and gone with it. File paths, since that is what reopens.
  const reopenStackRef = useRef<string[]>([]);
  const editorApiRef = useRef<WorkbenchEditorApi | null>(null);

  const isSshWorkspace = location?.kind === "ssh";
  const editorIoContext = useMemo(() => ({
    location: location ?? null,
    rootDir,
  }), [rootDir, location]);

  const activeTab = useMemo(() => getActiveTab(tabs, activeTabId), [tabs, activeTabId]);
  const activeFilePath = activeTab?.kind === "file" ? activeTab.filePath : null;
  // For code that resumes after an await: the file open now, not the one open when it started.
  const activeFilePathRef = useRef(activeFilePath);
  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
  }, [activeFilePath]);
  const activeDirty = activeTab?.kind === "file" ? Boolean(activeTab.dirty) : false;
  const activeLanguage = activeFilePath ? resolveEditorLanguage(activeFilePath) : null;
  const gitStatusByPath = useMemo(() => {
    return new Map(gitStatuses.map((status) => [status.path, status]));
  }, [gitStatuses]);

  // Callers' callbacks may change every render; the effects below must not restart for that.
  const onTabsChangeRef = useRef(onTabsChange);
  const onFileMissingRef = useRef(onFileMissing);
  const onDiskChangeRef = useRef(onDiskChange);
  useEffect(() => {
    onTabsChangeRef.current = onTabsChange;
    onFileMissingRef.current = onFileMissing;
    onDiskChangeRef.current = onDiskChange;
  }, [onDiskChange, onFileMissing, onTabsChange]);

  // The shown file's `.editorconfig` rules, read from its folder upwards.
  const [activeEditorConfig, setActiveEditorConfig] = useState<{ path: string; config: EditorConfig | null } | null>(null);
  useEffect(() => {
    if (!enabled || !activeFilePath || !isTauri()) return;
    let cancelled = false;
    const filePath = activeFilePath;
    void loadEditorConfig(filePath, async (configPath) => {
      const file = await readDiskFile(configPath, editorIoContext);
      return file.binary ? null : file.content;
    }).then((config) => {
      if (!cancelled) setActiveEditorConfig({ path: filePath, config });
    }, () => {});
    return () => {
      cancelled = true;
    };
  }, [activeFilePath, editorIoContext, enabled]);

  const refreshGitStatus = useCallback(async () => {
    if (!enabled) return;
    if (!isTauri()) return;

    setGitLoading(true);
    setGitError(null);
    try {
      const nextStatuses = await codespaceGitStatusFor(location ?? null, { repoRoot: rootDir });
      setGitStatuses(nextStatuses);
      setGitAvailable(true);
    } catch (nextError) {
      setGitStatuses([]);
      setGitAvailable(false);
      setGitSummary(null);
      // A folder outside git is a normal state, not a failure: Source already says "No repository
      // detected", so the status bar should not carry git's raw `fatal:` line forever.
      const message = describeError(nextError);
      setGitError(/not a git repository/i.test(message) ? null : message);
      setGitLoading(false);
      return;
    }

    try {
      setGitSummary(
        await codespaceGitRepoSummaryFor(location ?? null, { repoRoot: rootDir }),
      );
    } catch {
      setGitSummary(null);
    } finally {
      setGitLoading(false);
    }
  }, [rootDir, enabled, location]);

  /*
   * Git's copy of the shown file, for the editor's change marks. A file git lists as changed is
   * read from the index (as VS Code compares); one it does not list is clean, so its saved text
   * is that copy. A new (untracked) file, or a folder outside git, has no marks.
   */
  const [activeGitBaseline, setActiveGitBaseline] = useState<{ path: string; text: string | null } | null>(null);
  const activeGitStatus = activeFilePath ? gitStatusByPath.get(activeFilePath) ?? null : null;
  const activeGitKey = activeGitStatus ? `${activeGitStatus.staged ?? "-"}/${activeGitStatus.unstaged ?? "-"}` : "clean";
  useEffect(() => {
    if (!enabled || !activeFilePath || !gitAvailable || !isTauri()) return;
    let cancelled = false;
    const filePath = activeFilePath;
    const settle = (text: string | null) => {
      if (!cancelled) setActiveGitBaseline({ path: filePath, text });
    };
    const status = gitStatusByPath.get(filePath);
    if (status?.unstaged === "untracked" || status?.staged === "added") {
      void Promise.resolve(null).then(settle);
    } else if (!status) {
      // Clean: what is on disk is what git has. Read once the buffer is in.
      void Promise.resolve().then(() => settle(getEditorFileBuffer(filePath)?.savedContent ?? null));
    } else {
      void codespaceGitDiffFileContentFor(location ?? null, filePath, "unstaged", { repoRoot: rootDir })
        .then((diff) => settle(diff.original), () => settle(null));
    }
    return () => {
      cancelled = true;
    };
    // The status is named by its key; the map is new on every git refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilePath, activeGitKey, rootDir, enabled, gitAvailable, location, loadedPath]);

  useEffect(() => {
    if (isSshWorkspace) return;
    void refreshGitStatus();
  }, [isSshWorkspace, refreshGitStatus]);

  useEffect(() => {
    if (!isSshWorkspace || !gitVisible) return;
    void refreshGitStatus();
  }, [gitVisible, isSshWorkspace, refreshGitStatus]);

  const refreshGitStatusForVisibleView = useCallback(() => {
    if (isSshWorkspace && !gitVisible) return;
    void refreshGitStatus();
  }, [gitVisible, isSshWorkspace, refreshGitStatus]);

  const commitTabs = useCallback((nextTabs: WorkbenchTab[], nextActiveTabId: string | null) => {
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabId(nextActiveTabId);
    onTabsChangeRef.current?.({ tabs: nextTabs, activeTabId: nextActiveTabId });
  }, []);

  const setTabDirty = useCallback((filePath: string, dirty: boolean) => {
    let changed = false;
    // The newest list: this runs after awaits (a save, a read from disk).
    const nextTabs = tabsRef.current.map((tab) => {
      if (tab.kind !== "file" || tab.filePath !== filePath || Boolean(tab.dirty) === dirty) return tab;
      changed = true;
      // An edit keeps a preview tab: the next click in the tree must not take it away.
      const next = { ...tab, dirty };
      if (dirty) delete next.preview;
      return next;
    });
    if (!changed) return;
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    onTabsChangeRef.current?.({ tabs: nextTabs });
  }, []);

  const openFileTab = useCallback((filePath: string, options: { preview?: boolean } = {}) => {
    refreshGitStatusForVisibleView();
    const next = openFileInTabs(tabs, filePath, options);
    // A preview open can take the place of a clean preview tab: closed like any tab, so its
    // buffer goes and ⌘⇧T brings it back.
    const kept = new Set(openFilePaths(next.tabs));
    const replaced = openFilePaths(tabs).filter((path) => !kept.has(path));
    for (const path of replaced) releaseEditorFileBuffer(path, holderId);
    if (replaced.length > 0) reopenStackRef.current = pushClosedFiles(reopenStackRef.current, replaced);
    commitTabs(next.tabs, next.activeTabId);
  }, [holderId, commitTabs, refreshGitStatusForVisibleView, tabs]);

  // Open requests resolve against the current tabs, not the ones captured when a listener was installed.
  const openFileTabRef = useRef(openFileTab);
  useEffect(() => {
    openFileTabRef.current = openFileTab;
  }, [openFileTab]);

  const openDiffTab = useCallback((filePath: string, target: DiffTabTarget, repoRoot?: string) => {
    // The session's own repo is the default, so it is not written on the tab.
    const next = openDiffInTabs(tabsRef.current, filePath, target, repoRoot === rootDir ? undefined : repoRoot);
    commitTabs(next.tabs, next.activeTabId);
  }, [rootDir, commitTabs]);

  const closeTabsNow = useCallback((tabIds: readonly string[], preferredActiveId?: string) => {
    const closing = tabs.filter((tab) => tabIds.includes(tab.id));
    for (const tab of closing) {
      if (tab.kind === "file") {
        releaseEditorFileBuffer(tab.filePath, holderId);
      } else if (tab.kind === "url") {
        void destroyWebviewPane(buildCodeSpaceWebviewLabel("workbench", holderId, tab.id)).catch(() => {});
      }
    }
    const closedFiles = closing.flatMap((tab) => (tab.kind === "file" ? [tab.filePath] : []));
    reopenStackRef.current = pushClosedFiles(reopenStackRef.current, closedFiles);
    // Its edits are gone with the tab, so there is nothing left to choose about.
    endDiskConflicts((path) => closedFiles.includes(path));
    for (const path of closedFiles) setFileDeleted(path, false);
    const next = closeTabsInList(tabs, activeTabId, tabIds, preferredActiveId);
    commitTabs(next.tabs, next.activeTabId);
  }, [activeTabId, holderId, commitTabs, endDiskConflicts, setFileDeleted, tabs]);

  /** Closes the tabs, asking first when any of them holds unsaved edits. */
  const requestCloseTabs = useCallback((tabIds: string[], preferredActiveId?: string) => {
    if (tabIds.length === 0) return;
    const paths = unsavedFilePaths(tabs.filter((tab) => tabIds.includes(tab.id)))
      .filter((path) => !heldByAnotherPane(path, holderId));
    if (paths.length > 0) {
      setPendingClose({ tabIds, paths, preferredActiveId, busy: false, error: null });
      return;
    }
    closeTabsNow(tabIds, preferredActiveId);
  }, [holderId, closeTabsNow, tabs]);

  const closeTab = useCallback((tabId: string) => requestCloseTabs([tabId]), [requestCloseTabs]);

  const closeTabsInScope = useCallback((tabId: string, scope: TabCloseScope) => {
    const ids = tabsInCloseScope(tabs, tabId, scope).map((tab) => tab.id);
    // When the active tab is among those closed, the tab whose menu was used takes its place.
    requestCloseTabs(ids, scope === "one" ? undefined : tabId);
  }, [requestCloseTabs, tabs]);

  const keepPreviewTab = useCallback((tabId: string) => {
    const next = keepTab(tabs, tabId);
    if (next !== tabs) commitTabs(next, activeTabId);
  }, [activeTabId, commitTabs, tabs]);

  const pinTab = useCallback((tabId: string, pinned: boolean) => {
    const next = setTabPinned(tabs, tabId, pinned);
    if (next !== tabs) commitTabs(next, activeTabId);
  }, [activeTabId, commitTabs, tabs]);

  const reorderTab = useCallback((tabId: string, toIndex: number) => {
    commitTabs(moveTab(tabs, tabId, toIndex), activeTabId);
  }, [activeTabId, commitTabs, tabs]);

  const addUrlTab = useCallback(() => {
    if (!allowUrlTabs) return;
    const nextTab: WorkbenchTab = {
      id: crypto.randomUUID(),
      kind: "url",
      url: "",
      title: "URL",
    };
    commitTabs([...tabs, nextTab], nextTab.id);
  }, [allowUrlTabs, commitTabs, tabs]);

  // The save resolves after renders that may have changed the tabs; close against the current list.
  const closeTabsNowRef = useRef(closeTabsNow);
  useEffect(() => {
    closeTabsNowRef.current = closeTabsNow;
  }, [closeTabsNow]);

  const savePendingClose = useCallback(async () => {
    if (!pendingClose) return;
    setPendingClose({ ...pendingClose, busy: true, error: null });
    const { failed } = await saveUnsavedFiles(pendingClose.paths, editorIoContext);
    if (failed?.conflict) {
      // Nothing closes: the file stays open, with its banner, to choose there.
      setPendingClose(null);
      addDiskConflict(failed.path);
      const tab = tabsRef.current.find((candidate) => candidate.kind === "file" && candidate.filePath === failed.path);
      if (tab) commitTabs(tabsRef.current, tab.id);
      return;
    }
    if (failed) {
      setPendingClose({ ...pendingClose, busy: false, error: `Could not save ${fileName(failed.path)}: ${failed.message}` });
      return;
    }
    setPendingClose(null);
    closeTabsNowRef.current(pendingClose.tabIds, pendingClose.preferredActiveId);
  }, [addDiskConflict, commitTabs, editorIoContext, pendingClose]);

  // ⌘⇧T: the last closed file that still exists.
  const reopenInFlightRef = useRef(false);
  const reopenClosedTab = useCallback(async () => {
    if (reopenInFlightRef.current) return;
    reopenInFlightRef.current = true;
    try {
      const exists = (path: string) => readEditorFile(path, editorIoContext).then(() => true, () => false);
      const { path, stack } = await popReopenableFile(reopenStackRef.current, exists, openFilePaths(tabs));
      reopenStackRef.current = stack;
      if (path) openFileTabRef.current(path);
    } finally {
      reopenInFlightRef.current = false;
    }
  }, [editorIoContext, tabs]);

  const canReopenTab = useCallback(
    () => hasReopenCandidate(reopenStackRef.current, openFilePaths(tabs)),
    [tabs],
  );

  useEffect(() => {
    if (!enabled || !activeFilePath) return;

    let cancelled = false;
    const run = async () => {
      const cached = getEditorFileBuffer(activeFilePath);
      if (cached) {
        if (cancelled) return;
        setContent(cached.content);
        setBinary(cached.binary);
        setError(null);
        setLoading(false);
        setLoadedPath(activeFilePath);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const { buffer, restored } = await openEditorFile(activeFilePath, editorIoContext);
        if (cancelled) return;
        setContent(buffer.content);
        setBinary(buffer.binary);
        setLoadedPath(activeFilePath);
        // A tab saved as unsaved in the layout, whose edits did not survive, is clean now.
        setTabDirty(activeFilePath, buffer.dirty);
        setFileDeleted(activeFilePath, Boolean(buffer.deleted));
        if (restored) setDiskNotice(`Restored unsaved changes to ${fileName(activeFilePath)}`);
      } catch (nextError) {
        if (cancelled) return;
        setError(describeError(nextError));
        if (isMissingEditorFileError(nextError)) onFileMissingRef.current?.(activeFilePath);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [activeFilePath, editorIoContext, enabled, setFileDeleted, setTabDirty]);

  // After a crash: unsaved edits in the tabs that are not shown come back too, not only on click.
  const backupsCheckedRef = useRef(new Set<string>());
  const fileTabPathsKey = openFilePaths(tabs).join("\0");
  useEffect(() => {
    if (!enabled || !fileTabPathsKey) return;
    const checked = backupsCheckedRef.current;
    const paths = fileTabPathsKey.split("\0").filter((path) => path !== activeFilePathRef.current && !checked.has(path));
    if (paths.length === 0) return;
    for (const path of paths) checked.add(path);
    void Promise.all(paths.map((path) => restoreEditorBackup(path, editorIoContext).catch(() => null)))
      .then((results) => {
        const restored = results.filter((result) => result !== null);
        for (const { buffer } of restored) {
          setTabDirty(buffer.path, true);
          setFileDeleted(buffer.path, Boolean(buffer.deleted));
        }
        if (restored.length === 1) setDiskNotice(`Restored unsaved changes to ${fileName(restored[0].buffer.path)}`);
        else if (restored.length > 1) setDiskNotice(`Restored unsaved changes to ${restored.length} files`);
      });
  }, [editorIoContext, enabled, fileTabPathsKey, setFileDeleted, setTabDirty]);

  /** "Open anyway" on a file over the 10 MB text cap: read it with the 50 MB cap, from now on. */
  const openLargeFile = useCallback(async (filePath: string) => {
    allowLargeEditorFile(filePath);
    setLoading(true);
    setError(null);
    try {
      const buffer = await readEditorFile(filePath, editorIoContext);
      if (activeFilePathRef.current !== filePath) return;
      setContent(buffer.content);
      setBinary(buffer.binary);
      setLoadedPath(filePath);
    } catch (nextError) {
      if (activeFilePathRef.current === filePath) setError(describeError(nextError));
    } finally {
      if (activeFilePathRef.current === filePath) setLoading(false);
    }
  }, [editorIoContext]);

  /*
   * Auto save (Settings → Workbench Editor → Auto Save). Never for a file in a disk conflict
   * (the banner decides that), nor one deleted on disk (a save would bring back a file someone
   * removed on purpose); ⌘S still does both. What it saves with is set once `saveDirtyFile` is.
   */
  const autoSaveMode = preferences.autoSave;
  const autoSaveRef = useRef<{ mode: EditorAutoSave; save: ((path: string) => Promise<boolean>) | null; conflicts: ReadonlySet<string> }>({
    mode: autoSaveMode,
    save: null,
    conflicts: diskConflicts,
  });
  const autoSaveTimersRef = useRef(new Map<string, number>());
  const autoSaveFile = useCallback((path: string) => {
    const { save, conflicts } = autoSaveRef.current;
    const buffer = getEditorFileBuffer(path);
    if (!save || !buffer?.dirty || buffer.binary || buffer.deleted || conflicts.has(path)) return;
    void save(path);
  }, []);
  const scheduleAutoSave = useCallback((path: string) => {
    if (autoSaveRef.current.mode !== "afterDelay") return;
    const timers = autoSaveTimersRef.current;
    window.clearTimeout(timers.get(path));
    timers.set(path, window.setTimeout(() => {
      timers.delete(path);
      if (autoSaveRef.current.mode === "afterDelay") autoSaveFile(path);
    }, EDITOR_AUTO_SAVE_DELAY_MS));
  }, [autoSaveFile]);
  useEffect(() => {
    const timers = autoSaveTimersRef.current;
    if (autoSaveMode === "afterDelay") return;
    for (const timer of timers.values()) window.clearTimeout(timer);
    timers.clear();
  }, [autoSaveMode]);
  useEffect(() => {
    const timers = autoSaveTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
  // On focus change: the file left behind by a tab switch is saved.
  const previousActiveFileRef = useRef(activeFilePath);
  useEffect(() => {
    const previous = previousActiveFileRef.current;
    previousActiveFileRef.current = activeFilePath;
    if (previous && previous !== activeFilePath && autoSaveRef.current.mode === "onFocusChange") autoSaveFile(previous);
  }, [activeFilePath, autoSaveFile]);
  const handleEditorBlur = useCallback(() => {
    if (activeFilePath && autoSaveRef.current.mode === "onFocusChange") autoSaveFile(activeFilePath);
  }, [activeFilePath, autoSaveFile]);

  // Keys typed while a lost buffer is read back in: the newest text per file.
  const recoveringBuffersRef = useRef(new Map<string, string>());
  const handleEditorChange = useCallback((value: string) => {
    if (!activeFilePath) return;
    const recovering = recoveringBuffersRef.current;
    if (recovering.has(activeFilePath)) {
      recovering.set(activeFilePath, value);
      return;
    }
    const nextBuffer = updateEditorFileBuffer(activeFilePath, value);
    if (!nextBuffer) {
      // The buffer was thrown away under this tab (git discarded the file's edits, or a close
      // elsewhere). Read the disk copy back as the saved text and keep what was typed as an
      // edit, so the keys are not lost and ⌘S still saves them.
      const filePath = activeFilePath;
      recovering.set(filePath, value);
      void readEditorFile(filePath, editorIoContext)
        .then(() => {
          const typed = recovering.get(filePath) ?? value;
          const buffer = updateEditorFileBuffer(filePath, typed);
          if (buffer) setTabDirty(filePath, buffer.dirty);
        })
        .catch((nextError: unknown) => setSaveError(describeError(nextError)))
        .finally(() => recovering.delete(filePath));
      setContent(value);
      setTabDirty(filePath, true);
      return;
    }
    // No `setContent` per key: the editor shows the buffer, and a state change here re-rendered
    // the whole pane on every keystroke and pushed the text back into Monaco for a full compare.
    // Only a change that means something renders: the tab turning dirty or clean, or an error
    // going away.
    setBinary(nextBuffer.binary);
    setError(null);
    setSaveError(null);
    // Typing back to the saved text, or a reload pushed into the model, is not an unsaved edit.
    setTabDirty(activeFilePath, nextBuffer.dirty);
    if (nextBuffer.dirty) scheduleAutoSave(activeFilePath);
  }, [activeFilePath, editorIoContext, scheduleAutoSave, setTabDirty]);

  /*
   * What ⌘S does to the file before it writes (Settings, or the project's `.editorconfig`):
   * format, line endings, trailing whitespace, final line break. Only ⌘S and the save button run
   * it — auto save after a delay would eat the space just typed at a line's end.
   */
  const saveStepsRef = useRef({ preferences, config: activeEditorConfig, language: activeLanguage });
  useEffect(() => {
    saveStepsRef.current = { preferences, config: activeEditorConfig, language: activeLanguage };
  }, [activeEditorConfig, activeLanguage, preferences]);
  const prepareActiveSave = useCallback(async (filePath: string) => {
    const api = editorApiRef.current;
    if (!api) return;
    const { preferences: current, config, language } = saveStepsRef.current;
    const ownConfig = config?.path === filePath ? config.config : null;
    await api.prepareSave({
      filePath,
      format: current.formatOnSave,
      tidy: resolveSaveTidy(current, ownConfig, language),
      endOfLine: ownConfig?.endOfLine,
    }).catch(() => {});
  }, []);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    if (!activeFilePath) return false;
    try {
      await prepareActiveSave(activeFilePath);
      if (fileName(activeFilePath) === ".editorconfig") clearEditorConfigCache();
      const nextBuffer = await saveEditorFile(activeFilePath, editorIoContext);
      if (!nextBuffer) return false;
      setContent(nextBuffer.content);
      setBinary(nextBuffer.binary);
      setError(null);
      setSaveError(null);
      setTabDirty(activeFilePath, nextBuffer.dirty);
      setFileDeleted(activeFilePath, false);
      endDiskConflicts((path) => path === activeFilePath);
      await refreshGitStatus();
      return true;
    } catch (nextError) {
      if (isSaveConflict(nextError)) addDiskConflict(activeFilePath);
      else setSaveError(describeError(nextError));
      return false;
    }
  }, [activeFilePath, addDiskConflict, editorIoContext, enabled, endDiskConflicts, prepareActiveSave, refreshGitStatus, setFileDeleted, setTabDirty]);

  const saveDirtyFile = useCallback(async (filePath: string): Promise<boolean> => {
    const buffer = getEditorFileBuffer(filePath);
    if (!buffer?.dirty) return true;
    try {
      const nextBuffer = await saveEditorFile(filePath, editorIoContext);
      if (!nextBuffer) return false;
      if (filePath === activeFilePath) {
        setContent(nextBuffer.content);
        setBinary(nextBuffer.binary);
        setError(null);
        setSaveError(null);
      }
      setTabDirty(filePath, nextBuffer.dirty);
      setFileDeleted(filePath, false);
      return true;
    } catch (nextError) {
      const message = describeError(nextError);
      if (isSaveConflict(nextError)) {
        addDiskConflict(filePath);
        // Staging waits on this save; say why it did not go on.
        if (filePath !== activeFilePath) setGitError(`${fileName(filePath)} changed on disk. Open it to Compare, Reload or Overwrite.`);
      } else if (filePath === activeFilePath) {
        setSaveError(message);
      } else {
        setGitError(message);
      }
      return false;
    }
  }, [activeFilePath, addDiskConflict, editorIoContext, setFileDeleted, setTabDirty]);

  useEffect(() => {
    autoSaveRef.current = { mode: autoSaveMode, save: saveDirtyFile, conflicts: diskConflicts };
  }, [autoSaveMode, diskConflicts, saveDirtyFile]);

  const saveAllDirtyFiles = useCallback(async (): Promise<boolean> => {
    const dirtyBuffers = getEditorFileBuffers().filter((buffer) =>
      buffer.dirty && isInsideRoot(rootDir, buffer.path),
    );
    for (const buffer of dirtyBuffers) {
      const saved = await saveDirtyFile(buffer.path);
      if (!saved) return false;
    }
    return true;
  }, [rootDir, saveDirtyFile]);

  /** An error about `filePath`, shown as its own if that file is still the one open. */
  const reportFileError = useCallback((filePath: string, error: unknown) => {
    const message = describeError(error);
    if (activeFilePathRef.current === filePath) setSaveError(message);
    else setGitError(`${fileName(filePath)}: ${message}`);
  }, []);

  /**
   * A file changed on disk while open. A clean buffer takes the new text; one with edits gets
   * the conflict banner now rather than at its next save. Our own save coming back is a no-op.
   */
  const syncFromDisk = useCallback(async (filePath: string) => {
    if (!getEditorFileBuffer(filePath)) return;
    let file;
    try {
      file = await readDiskFile(filePath, editorIoContext);
    } catch (nextError) {
      // Deleted: the tab keeps its text, is struck through, and a save puts the file back.
      // Unreadable for another reason: it keeps what it has, and a save will say what is wrong.
      if (isMissingEditorFileError(nextError)) {
        if (markEditorFileDeleted(filePath)) setDiskNotice(`${fileName(filePath)} was deleted on disk. Save to put it back.`);
        setFileDeleted(filePath, true);
      }
      return;
    }
    setFileDeleted(filePath, false);
    const result = applyDiskFile(filePath, file);
    if (result === "conflict") {
      addDiskConflict(filePath);
      return;
    }
    if (result === "reloaded") {
      if (activeFilePathRef.current === filePath) {
        setContent(file.content);
        setBinary(file.binary);
        setError(null);
        if (file.binary) setMediaVersion((version) => version + 1);
      }
      setDiskNotice(`${fileName(filePath)} updated on disk`);
    }
    // Either way the buffer may now be clean: the disk caught up with the edits.
    if (!getEditorFileBuffer(filePath)?.dirty) {
      setTabDirty(filePath, false);
      endDiskConflicts((path) => path === filePath);
    }
  }, [addDiskConflict, editorIoContext, endDiskConflicts, setFileDeleted, setTabDirty]);

  // The banner's three ways out. A second click while one runs does nothing.
  const conflictActionRef = useRef(false);
  const runConflictAction = useCallback(async (action: () => Promise<void>) => {
    if (conflictActionRef.current) return;
    conflictActionRef.current = true;
    try {
      await action();
    } finally {
      conflictActionRef.current = false;
    }
  }, []);

  const reloadFromDisk = useCallback((filePath: string) => runConflictAction(async () => {
    const name = fileName(filePath);
    if (getEditorFileBuffer(filePath)?.dirty
      && !window.confirm(`Reload ${name} from disk?\n\nYour unsaved edits to it will be lost.`)) return;
    try {
      const buffer = await reloadEditorFile(filePath, editorIoContext);
      if (activeFilePathRef.current === filePath) {
        setContent(buffer.content);
        setBinary(buffer.binary);
        setError(null);
        setSaveError(null);
      }
      setTabDirty(filePath, false);
      endDiskConflicts((path) => path === filePath);
    } catch (nextError) {
      reportFileError(filePath, nextError);
    }
  }), [editorIoContext, endDiskConflicts, reportFileError, runConflictAction, setTabDirty]);

  const overwriteDisk = useCallback((filePath: string) => runConflictAction(async () => {
    try {
      const buffer = await saveEditorFile(filePath, editorIoContext, { overwrite: true });
      if (!buffer) return;
      setTabDirty(filePath, buffer.dirty);
      setFileDeleted(filePath, false);
      endDiskConflicts((path) => path === filePath);
      setSaveError(null);
      await refreshGitStatus();
    } catch (nextError) {
      reportFileError(filePath, nextError);
    }
  }), [editorIoContext, endDiskConflicts, refreshGitStatus, reportFileError, runConflictAction, setFileDeleted, setTabDirty]);

  /** Compare: the file on disk now on the left, the unsaved edits on the right. */
  const diskAgainstEdits = useCallback(async (filePath: string): Promise<CodespaceGitFileDiffContent> => {
    const disk = await readDiskFile(filePath, editorIoContext);
    return {
      original: disk.content,
      modified: getEditorFileBuffer(filePath)?.content ?? disk.content,
      originalPath: `disk://${filePath}`,
      modifiedPath: `edits://${filePath}`,
    };
  }, [editorIoContext]);

  /** After git threw changes away: unsaved edits to those files go too, and the open one is read again. */
  const forgetLocalEdits = useCallback(async (discarded: (path: string) => boolean) => {
    for (const buffer of getEditorFileBuffers()) {
      if (discarded(buffer.path)) clearEditorFileBuffer(buffer.path);
    }
    endDiskConflicts(discarded);
    let changed = false;
    const nextTabs = tabsRef.current.map((tab) => {
      if (tab.kind !== "file" || !discarded(tab.filePath) || !tab.dirty) return tab;
      changed = true;
      return { ...tab, dirty: false };
    });
    if (changed) {
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      onTabsChangeRef.current?.({ tabs: nextTabs });
    }
    const openPath = activeFilePathRef.current;
    if (openPath && discarded(openPath)) {
      try {
        const buffer = await readEditorFile(openPath, editorIoContext);
        if (activeFilePathRef.current !== openPath) return;
        setContent(buffer.content);
        setBinary(buffer.binary);
        setError(null);
        setSaveError(null);
      } catch (nextError) {
        if (activeFilePathRef.current !== openPath) return;
        // An untracked file that was discarded is gone.
        setContent("");
        setBinary(false);
        setError(describeError(nextError));
      }
    }
  }, [editorIoContext, endDiskConflicts]);

  /** The file shown was removed: nothing is on screen for it any more. */
  const clearShownFile = useCallback(() => {
    setContent("");
    setBinary(false);
    setError(null);
    setSaveError(null);
  }, []);

  /** A rename or move: conflict banners and strike-throughs follow the file to its new path. */
  const remapTrackedPaths = useCallback((moved: (path: string) => string | null) => {
    updateDiskConflicts((paths) => paths.map((path) => moved(path) ?? path));
    setDeletedFiles((current) => (current.size === 0 ? current : new Set([...current].map((path) => moved(path) ?? path))));
  }, [updateDiskConflicts]);

  // An agent writing file after file must not run `git status` every 150 ms: once, a second
  // after the last change.
  const gitRefreshTimerRef = useRef<number | null>(null);
  const refreshGitStatusForVisibleViewRef = useRef(refreshGitStatusForVisibleView);
  useEffect(() => {
    refreshGitStatusForVisibleViewRef.current = refreshGitStatusForVisibleView;
  }, [refreshGitStatusForVisibleView]);
  const scheduleGitRefresh = useCallback(() => {
    if (gitRefreshTimerRef.current !== null) window.clearTimeout(gitRefreshTimerRef.current);
    gitRefreshTimerRef.current = window.setTimeout(() => {
      gitRefreshTimerRef.current = null;
      refreshGitStatusForVisibleViewRef.current();
    }, 1000);
  }, []);
  useEffect(() => () => {
    if (gitRefreshTimerRef.current !== null) window.clearTimeout(gitRefreshTimerRef.current);
  }, []);

  const handleDiskChange = useCallback((change: EditorFsChange) => {
    const changed = new Set(change.paths);
    for (const tab of tabsRef.current) {
      if (tab.kind === "file" && (change.overflow || changed.has(normalizePath(tab.filePath)))) void syncFromDisk(tab.filePath);
    }
    scheduleGitRefresh();
    onDiskChangeRef.current?.(change);
  }, [scheduleGitRefresh, syncFromDisk]);

  // The listener is installed once per watch; it must act on the current tabs.
  const handleDiskChangeRef = useRef(handleDiskChange);
  const syncFromDiskRef = useRef(syncFromDisk);
  useEffect(() => {
    handleDiskChangeRef.current = handleDiskChange;
    syncFromDiskRef.current = syncFromDisk;
  }, [handleDiskChange, syncFromDisk]);

  // While off screen (or unmounted) nothing watched, but the buffers stayed in the shared store: on
  // coming back, every open tab is looked at against disk, so a file that moved meanwhile does not
  // show its old text. Clean buffers take the new text; ones with edits get the conflict banner.
  useEffect(() => {
    if (!enabled) return;
    for (const tab of tabsRef.current) {
      if (tab.kind === "file") void syncFromDiskRef.current(tab.filePath);
    }
  }, [enabled]);

  // Only while on screen: a workspace in the background watches nothing (the gating plan).
  useEffect(() => {
    if (!enabled || isSshWorkspace) return;
    return watchEditorRoot(holderId, rootDir, (change) => handleDiskChangeRef.current(change));
  }, [holderId, rootDir, enabled, isSshWorkspace]);

  // SSH has no watcher: coming back to the window is when the open files and git are looked at
  // again.
  useEffect(() => {
    if (!enabled || !isSshWorkspace) return;
    const onFocus = () => {
      for (const tab of tabsRef.current) {
        if (tab.kind === "file") void syncFromDiskRef.current(tab.filePath);
      }
      refreshGitStatusForVisibleViewRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, isSshWorkspace]);

  useEffect(() => {
    if (!diskNotice) return;
    const timer = window.setTimeout(() => setDiskNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [diskNotice]);

  return {
    // tabs
    tabs,
    activeTabId,
    activeTab,
    activeFilePath,
    activeFilePathRef,
    activeDirty,
    activeLanguage,
    tabsRef,
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
    // the shown buffer
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
    activeGitBaseline: gitAvailable ? activeGitBaseline : null,
    handleEditorChange,
    handleEditorBlur,
    openLargeFile,
    clearShownFile,
    // save
    handleSave,
    saveDirtyFile,
    saveAllDirtyFiles,
    // disk conflict
    diskConflicts,
    deletedFiles,
    addDiskConflict,
    endDiskConflicts,
    setFileDeleted,
    remapTrackedPaths,
    reloadFromDisk,
    overwriteDisk,
    diskAgainstEdits,
    forgetLocalEdits,
    // git status
    gitStatuses,
    gitStatusByPath,
    gitSummary,
    gitAvailable,
    gitLoading,
    gitError,
    setGitError,
    refreshGitStatus,
    refreshGitStatusForVisibleView,
  };
}

export type WorkbenchSession = ReturnType<typeof useWorkbenchSession>;
