"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search, SquareArrowOutUpRight } from "lucide-react";
import type { CodespaceGitFileDiffContent } from "@/lib/tauri-api";
import { editorIndexFilesFor, type CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import { copyTextToClipboard } from "@/lib/clipboard";
import type { WorkbenchTab } from "@/modules/codespace/components/types";
import { GoToFilePalette } from "@/modules/codespace/components/workbench/GoToFilePalette";
import { UnsavedChangesDialog } from "@/modules/codespace/components/workbench/UnsavedChangesDialog";
import { WorkbenchConflictBanner } from "@/modules/codespace/components/workbench/WorkbenchConflictBanner";
import { WorkbenchDiffTab } from "@/modules/codespace/components/workbench/WorkbenchDiffTab";
import { WorkbenchEditor } from "@/modules/codespace/components/workbench/WorkbenchEditor";
import { WorkbenchStatusBar } from "@/modules/codespace/components/workbench/WorkbenchStatusBar";
import { WorkbenchTabBar } from "@/modules/codespace/components/workbench/WorkbenchTabBar";
import { WorkbenchTrustBanner } from "@/modules/codespace/components/workbench/WorkbenchTrustBanner";
import type { EditorLineSelection, SelectionAction } from "@/modules/codespace/components/workbench/SelectionPopover";
import { useEditorPreferences } from "@/modules/codespace/hooks/useEditorPreferences";
import { useLspStatus } from "@/modules/codespace/hooks/useLspStatus";
import { useWorkbenchSession } from "@/modules/codespace/hooks/useWorkbenchSession";
import type { DiffLayout } from "@/modules/codespace/services/diff-layout";
import { EDITOR_LARGE_FILE_LIMIT_BYTES, getEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";
import { resolveEditorLanguage } from "@/modules/codespace/services/editor-languages";
import type { EditorStatus } from "@/modules/codespace/services/editor-status";
import { notifyLspFilesChanged, onLspNotice, restartLspForFile } from "@/modules/codespace/services/lsp/lsp-manager";
import { isFolderTrusted, trustKey } from "@/modules/codespace/services/lsp/lsp-trust";
import { forgetRecentFiles, listRecentFiles, recordRecentFile, type RecentFile } from "@/modules/codespace/services/recent-files";
import {
  buildCodeSelectionPayload,
  formatPathRange,
  withAskAboutLine,
} from "@/modules/codespace/services/selection-payload";
import { onSelectionSend, sendSelectionToAgent, type SelectionSendResult } from "@/modules/codespace/services/selection-send";
import { describeError, fileName } from "@/modules/codespace/services/workbench-paths";
import type { CodeOpenRequest } from "../hooks/useCanvasDock";
import { useAgentStatusSnapshots } from "../hooks/useAgentStatusSnapshots";
import type { AgentStatusRegistry } from "../services/agent-status-registry";
import { machineKey, type Machine } from "../services/machine";
import { changedByBoard } from "../services/changed-by-board";
import { agentStateRegistry } from "../services/narration/agent-state-registry";

/** Names this editing session to the shared buffer store: a file open here and in CodeSpace is one buffer. */
export const CODE_DOCK_HOLDER_ID = "canvas-code-dock";

const FILE_INDEX_MAX_AGE_MS = 60_000;
const NO_RECENT: RecentFile[] = [];

/**
 * The tabs outlive the Dock being closed: the app unmounts with it, but its buffers (and their
 * backups) stay in the shared store, so the tabs must come back with them.
 */
let rememberedTabs: { rootKey: string; tabs: WorkbenchTab[]; activeTabId: string | null } = { rootKey: "", tabs: [], activeTabId: null };

/** The board's machine, in the shape the editor commands take. A local board needs none. */
export function editorLocationOf(location: Machine | null | undefined): CodeSpaceStoredWorkspaceLocation | null {
  return location ? { kind: "ssh", host: location.host, user: location.user, port: location.port, label: location.label } : null;
}

function rootKeyOf(location: Machine | null | undefined, rootDir: string): string {
  return `${location ? machineKey(location) : "local"}:${rootDir}`;
}

function relativeTo(rootDir: string, path: string): string {
  const root = rootDir.replace(/\/+$/, "");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

export interface CodeDockAppProps {
  /** The board's folder. None: there is no project to edit. */
  rootDir: string | null;
  location?: Machine | null;
  /** A file another part of the canvas asked Code to open (`openInCode`). */
  request?: CodeOpenRequest | null;
  /** Injected for tests; production uses the process-wide store. */
  registry?: AgentStatusRegistry;
  /** "Show on board": close the Dock and fly to that file's File Node (made first when there is none). */
  onShowOnBoard?: (path: string) => void;
  /** A "Changed by this board" row's "Open file on board": the File Node, wired to the agent that touched it. */
  onOpenFileFromAgent?: (path: string, agentNodeId: string) => void;
  /** Where "Send to thread" goes. Absent: the selection cannot be handed to an agent from here yet. */
  onSendToAgent?: (text: string) => SelectionSendResult;
}

/**
 * Code, the Dock's editor (`plans/canvas-code/`, S2): CodeSpace's Workbench editor at 100% scale,
 * on the same session module (`useWorkbenchSession`), so tabs, dirty state, save, the "changed on
 * disk" banner and git marks are CodeSpace's. Its left column is not a file tree: "Changed by this
 * board" plus ⌘P. It never renders inside the viewport's transform, which is the point of living in
 * the Dock.
 */
export function CodeDockApp(props: CodeDockAppProps) {
  if (!props.rootDir) {
    return <p className="canvas-dock-empty">Open a project on this board to edit its files.</p>;
  }
  // Keyed by the root: another project or machine starts its own tabs, seeded from its own memory,
  // instead of carrying the old project's tabs over and filing them under the new key.
  return <CodeWorkbench key={rootKeyOf(props.location, props.rootDir)} {...props} rootDir={props.rootDir} />;
}

type DiskDiff = { key: string; content: CodespaceGitFileDiffContent | null; error: string | null };

function CodeWorkbench({
  rootDir,
  location: boardLocation = null,
  request = null,
  registry,
  onShowOnBoard,
  onOpenFileFromAgent,
  onSendToAgent,
}: CodeDockAppProps & { rootDir: string }) {
  const location = useMemo(() => editorLocationOf(boardLocation), [boardLocation?.host, boardLocation?.user, boardLocation?.port, boardLocation?.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const rootKey = rootKeyOf(boardLocation, rootDir);
  const [editorPreferences, updateEditorPreferences] = useEditorPreferences();
  const { wordWrap, fontSize } = editorPreferences;
  const rootRef = useRef<HTMLDivElement>(null);
  const [editorStatus, setEditorStatus] = useState<EditorStatus | null>(null);
  const [openedFrom, setOpenedFrom] = useState<string | null>(null);
  const [revealRequest, setRevealRequest] = useState<{ path: string; startLine: number; endLine: number; nonce: number } | null>(null);
  const [manualDiffLayout, setManualDiffLayout] = useState<DiffLayout | null>(null);
  const [diskDiff, setDiskDiff] = useState<DiskDiff>({ key: "", content: null, error: null });
  const [trustAsked, setTrustAsked] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(NO_RECENT);

  const restored = rememberedTabs.rootKey === rootKey ? rememberedTabs : null;
  const [initial] = useState(() => ({ tabs: restored?.tabs ?? [], activeTabId: restored?.activeTabId ?? null }));
  const session = useWorkbenchSession({
    holderId: CODE_DOCK_HOLDER_ID,
    location,
    rootDir,
    enabled: true,
    initialTabs: initial.tabs,
    initialActiveTabId: initial.activeTabId,
    allowUrlTabs: false,
    preferences: editorPreferences,
    onTabsChange: (patch) => {
      rememberedTabs = {
        rootKey,
        tabs: patch.tabs,
        activeTabId: patch.activeTabId !== undefined ? patch.activeTabId : rememberedTabs.activeTabId,
      };
    },
    onFileMissing: (path) => forgetRecentFiles(rootKey, path),
    onDiskChange: (change) => notifyLspFilesChanged(location, change.paths),
  });
  const {
    tabs, activeTabId, activeTab, activeFilePath, activeDirty, activeLanguage, openFileTabRef,
    commitTabs, closeTab, closeTabsInScope, keepPreviewTab, pinTab, reorderTab, openDiffTab,
    pendingClose, setPendingClose, savePendingClose, closeTabsNow,
    editorApiRef, loading, content, binary, error, loadedPath, saveError, diskNotice, setDiskNotice,
    activeEditorConfig, activeGitBaseline, handleEditorChange, handleEditorBlur, openLargeFile, handleSave,
    diskConflicts, deletedFiles, reloadFromDisk, overwriteDisk, diskAgainstEdits,
    gitStatusByPath, gitSummary, gitAvailable, gitError,
  } = session;

  // ---- opening files: the board's request, and a place to land at a line
  const openAt = useCallback((path: string, line?: number) => {
    openFileTabRef.current(path);
    if (line) setRevealRequest({ path, startLine: line, endLine: line, nonce: Date.now() });
  }, [openFileTabRef]);
  const seenRequestRef = useRef(0);
  useEffect(() => {
    if (!request || request.seq <= seenRequestRef.current) return;
    seenRequestRef.current = request.seq;
    openAt(request.path, request.line);
    setOpenedFrom(request.path);
  }, [request, openAt]);

  // ---- ⌘P over the whole project
  const [goToFileOpen, setGoToFileOpen] = useState(false);
  const [fileIndex, setFileIndex] = useState<{ key: string; files: string[]; truncated: boolean; at: number; error: string | null } | null>(null);
  const focusBeforePaletteRef = useRef<HTMLElement | null>(null);
  const ensureFileIndex = useCallback(() => {
    if (fileIndex && fileIndex.key === rootKey && !fileIndex.error && Date.now() - fileIndex.at < FILE_INDEX_MAX_AGE_MS) return;
    void editorIndexFilesFor(location, rootDir)
      .then((index) => setFileIndex({ key: rootKey, files: index.files, truncated: index.truncated, at: Date.now(), error: null }))
      .catch((err) => setFileIndex({ key: rootKey, files: [], truncated: false, at: 0, error: describeError(err) }));
  }, [fileIndex, location, rootDir, rootKey]);
  const openGoToFile = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) focusBeforePaletteRef.current = document.activeElement;
    setGoToFileOpen(true);
    ensureFileIndex();
  }, [ensureFileIndex]);
  const closeGoToFile = useCallback(() => {
    setGoToFileOpen(false);
    // Put focus back, or ⌘P would stop answering.
    window.setTimeout(() => {
      const back = focusBeforePaletteRef.current;
      if (back?.isConnected) back.focus();
      else rootRef.current?.focus();
    }, 0);
  }, []);
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      event.stopPropagation();
      openGoToFile();
    }
  };

  useEffect(() => setRecentFiles(listRecentFiles(rootKey)), [rootKey]);
  useEffect(() => {
    if (!activeFilePath) return;
    recordRecentFile(rootKey, activeFilePath);
    setRecentFiles(listRecentFiles(rootKey));
  }, [activeFilePath, rootKey]);

  // ---- language servers: the same Settings switch and per-folder trust gate as CodeSpace
  const lspTrusted = isFolderTrusted(editorPreferences.trustedFolders, location, rootDir);
  const lspPlace = useMemo(() => ({ location, rootDir }), [location, rootDir]);
  const lspOptions = useMemo(
    () => ({ place: lspPlace, enabled: editorPreferences.languageServers, trusted: lspTrusted }),
    [editorPreferences.languageServers, lspPlace, lspTrusted],
  );
  const { status: lspStatus, problems: lspProblems } = useLspStatus(activeFilePath, lspPlace);
  const trustFolder = useCallback(() => {
    updateEditorPreferences({ trustedFolders: [...editorPreferences.trustedFolders, trustKey(location, rootDir)] });
  }, [editorPreferences.trustedFolders, location, rootDir, updateEditorPreferences]);
  useEffect(() => onLspNotice((notice) => setDiskNotice(notice.text)), [setDiskNotice]);
  const onLanguageServerClick = useCallback(() => {
    if (!lspStatus || !activeFilePath) return;
    if (lspStatus.kind === "off") updateEditorPreferences({ languageServers: true });
    else if (lspStatus.kind === "untrusted") setTrustAsked(false);
    else if (lspStatus.kind === "error") void restartLspForFile(activeFilePath);
    else if (lspStatus.kind === "missing") {
      void copyTextToClipboard(lspStatus.installHint)
        .then(() => setDiskNotice(`Copied: ${lspStatus.installHint}`))
        .catch(() => setDiskNotice(`Install ${lspStatus.label} with: ${lspStatus.installHint}`));
    }
  }, [activeFilePath, lspStatus, setDiskNotice, updateEditorPreferences]);

  // ---- Send to thread: the text is built here; the board decides which agent gets it
  const sendRef = useRef(onSendToAgent);
  sendRef.current = onSendToAgent;
  useEffect(
    () =>
      onSelectionSend((sourceCellId, text) =>
        sourceCellId === CODE_DOCK_HOLDER_ID
          ? (sendRef.current?.(text) ?? { ok: false, reason: "Sending to a thread from Code is not wired on this board yet." })
          : null,
      ),
    [],
  );
  const handleEditorSelection = useCallback((action: SelectionAction, selection: EditorLineSelection) => {
    if (!activeFilePath) return;
    const shown = relativeTo(rootDir, activeFilePath);
    const payload = buildCodeSelectionPayload({ ...selection, path: shown, language: resolveEditorLanguage(activeFilePath) });
    const pathRange = formatPathRange(shown, selection.startLine, selection.endLine);
    if (action === "copy") {
      void copyTextToClipboard(pathRange)
        .then(() => setDiskNotice(`Copied ${pathRange}`))
        .catch((err: unknown) => setDiskNotice(describeError(err)));
      return;
    }
    const result = sendSelectionToAgent(CODE_DOCK_HOLDER_ID, action === "ask" ? withAskAboutLine(payload) : payload);
    if (!result.ok) setDiskNotice(result.reason);
  }, [activeFilePath, rootDir, setDiskNotice]);

  // ---- Compare (the conflict banner): your buffer against what is on disk
  const diffPath = activeTab?.kind === "diff" && activeTab.target === "disk" ? activeTab.filePath : null;
  useEffect(() => {
    if (!diffPath) return;
    let cancelled = false;
    const key = `disk:${diffPath}`;
    void diskAgainstEdits(diffPath)
      .then((diff) => !cancelled && setDiskDiff({ key, content: diff, error: null }))
      .catch((err) => !cancelled && setDiskDiff({ key, content: null, error: describeError(err) }));
    return () => {
      cancelled = true;
    };
  }, [diffPath, diskAgainstEdits]);

  // ---- "Changed by this board"
  const snapshots = useAgentStatusSnapshots(registry);
  const [, bumpStates] = useState(0);
  useEffect(() => agentStateRegistry.subscribe(() => bumpStates((n) => n + 1)), []);
  const changed = changedByBoard({
    states: agentStateRegistry.all(),
    rootDir,
    live: snapshots,
    statusOf: (path) => {
      const status = gitStatusByPath.get(path);
      const kind = status?.staged ?? status?.unstaged;
      return kind === "added" || kind === "untracked" ? "A" : "M";
    },
  });

  // ---- what is on screen
  const activeBuffer = activeFilePath ? getEditorFileBuffer(activeFilePath) : null;
  const shownContent = activeBuffer && loadedPath === activeFilePath ? activeBuffer.content : content;
  const activeTooLarge = activeFilePath && activeBuffer?.tooLarge
    ? {
        sizeBytes: activeBuffer.sizeBytes,
        onOpenAnyway: activeBuffer.sizeBytes <= EDITOR_LARGE_FILE_LIMIT_BYTES ? () => void openLargeFile(activeFilePath) : null,
      }
    : null;
  const bannerPath = activeFilePath ?? diffPath;
  const conflictPath = bannerPath && diskConflicts.has(bannerPath) ? bannerPath : null;
  const projectName = fileName(rootDir) || rootDir;
  const showBoardTarget = activeFilePath ?? diffPath;
  const files = fileIndex && fileIndex.key === rootKey ? fileIndex : null;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
      className="canvas-dock-code codespace-panel-surface outline-none relative flex h-full min-h-0 flex-col overflow-hidden"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-[color:var(--codespace-panel-border)] px-3 py-2 text-[12px]">
        <h2 className="m-0 text-[13px] font-semibold text-[color:var(--codespace-panel-text)]">Code</h2>
        <span className="rounded-[6px] border border-[color:var(--codespace-panel-border)] px-1.5 py-0.5 text-[11px] text-[color:var(--codespace-panel-text-muted)]" title={rootDir}>
          {projectName}
        </span>
        {openedFrom ? (
          <span className="truncate text-[11px] text-[color:var(--codespace-panel-text-muted)]" title={openedFrom}>
            Opened from {fileName(openedFrom)} on the board
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          disabled={!showBoardTarget}
          onClick={() => showBoardTarget && onShowOnBoard?.(showBoardTarget)}
          className="flex items-center gap-1.5 rounded-[6px] border border-[color:var(--codespace-panel-border)] px-2 py-1 text-[11.5px] text-[color:var(--codespace-panel-text-muted)] hover:bg-[color:var(--codespace-panel-surface-hover)] disabled:opacity-40"
          title="Close the Dock and show this file on the board"
        >
          <SquareArrowOutUpRight className="h-3 w-3" aria-hidden="true" />
          Show on board
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="canvas-dock-code-side flex w-[196px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-[color:var(--codespace-panel-border)] p-2" aria-label="Changed by this board">
          <button
            type="button"
            onClick={openGoToFile}
            className="flex items-center gap-2 rounded-[6px] border border-[color:var(--codespace-panel-border)] px-2 py-1 text-[11.5px] text-[color:var(--codespace-panel-text-muted)] hover:bg-[color:var(--codespace-panel-surface-hover)]"
            title="Go to file (⌘P)"
          >
            <Search className="h-3 w-3" aria-hidden="true" />
            Go to file
            <kbd className="ml-auto rounded-[4px] bg-[color:var(--codespace-panel-surface-active)] px-1 font-mono text-[11px]">⌘P</kbd>
          </button>
          <h3 className="m-0 mt-2 px-1 text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--codespace-panel-text-muted)]">Changed by this board</h3>
          {changed.length === 0 ? (
            <p className="m-0 px-1 text-[11.5px] text-[color:var(--codespace-panel-text-muted)]">Nothing yet. Files an agent here edits will show up.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {changed.map((row) => (
                <li key={row.path}>
                  <button
                    type="button"
                    onClick={() => openAt(row.path)}
                    aria-current={row.path === activeFilePath ? "true" : undefined}
                    className="flex w-full flex-col items-start rounded-[6px] px-1.5 py-1 text-left hover:bg-[color:var(--codespace-panel-surface-hover)] aria-[current=true]:bg-[color:var(--codespace-panel-surface-active)]"
                    title={row.path}
                  >
                    <span className="flex w-full items-center gap-1.5 text-[12px] text-[color:var(--codespace-panel-text)]">
                      <span className="font-mono text-[10.5px] text-[color:var(--codespace-panel-text-muted)]" aria-label={row.status === "A" ? "Added" : "Modified"}>{row.status}</span>
                      <span className="truncate">{fileName(row.path)}</span>
                    </span>
                    <span className="w-full truncate text-[10.5px] text-[color:var(--codespace-panel-text-muted)]">{row.agent} · {row.relativePath}</span>
                  </button>
                  {onOpenFileFromAgent ? (
                    <button
                      type="button"
                      onClick={() => onOpenFileFromAgent(row.path, row.agentNodeId)}
                      className="ml-1.5 flex items-center gap-1 rounded-[4px] px-1 py-0.5 text-[10.5px] text-[color:var(--codespace-panel-text-muted)] hover:bg-[color:var(--codespace-panel-surface-hover)]"
                      title={`Place ${fileName(row.path)} on the board, wired to ${row.agent}`}
                    >
                      <SquareArrowOutUpRight className="h-2.5 w-2.5" aria-hidden="true" />
                      Open file on board
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          {tabs.length > 0 ? (
            <WorkbenchTabBar
              tabs={tabs}
              activeTabId={activeTabId}
              onSelectTab={(tabId) => commitTabs(tabs, tabId)}
              onCloseTab={closeTab}
              onCloseTabs={closeTabsInScope}
              onNewUrlTab={() => {}}
              onKeepTab={keepPreviewTab}
              onPinTab={pinTab}
              onMoveTab={reorderTab}
              allowUrlTabs={false}
              allowNewUrlTabs={false}
              deletedPaths={deletedFiles}
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
              folderName={projectName}
              onTrust={trustFolder}
              onDismiss={() => setTrustAsked(true)}
            />
          ) : null}
          {activeTab?.kind === "diff" && diffPath ? (
            <WorkbenchDiffTab
              filePath={diffPath}
              displayPath={relativeTo(rootDir, diffPath)}
              target="disk"
              sides={[]}
              onTargetChange={() => {}}
              manualLayout={manualDiffLayout}
              onLayoutChange={setManualDiffLayout}
              onOpenFile={() => openAt(diffPath)}
              content=""
              fileContent={diskDiff.key === `disk:${diffPath}` && diskDiff.content
                ? diskDiff.content
                : { original: "", modified: "", originalPath: "original://empty", modifiedPath: "modified://empty" }}
              loading={diskDiff.key !== `disk:${diffPath}`}
              error={diskDiff.key === `disk:${diffPath}` ? diskDiff.error : null}
              fontSize={fontSize}
            />
          ) : !activeTab ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[12px] text-[color:var(--codespace-panel-text-muted)]">
              <p className="m-0">Pick a file from the list, or press ⌘P.</p>
              <button
                type="button"
                onClick={openGoToFile}
                className="rounded-[6px] border border-[color:var(--codespace-panel-border)] px-2 py-1 hover:bg-[color:var(--codespace-panel-surface-hover)]"
              >
                Go to file
              </button>
            </div>
          ) : (
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
              fontSize={fontSize}
              onStatusChange={setEditorStatus}
              rootDir={rootDir}
              onSelectionAction={handleEditorSelection}
              onBlur={handleEditorBlur}
              onEditorReady={(api) => {
                editorApiRef.current = api;
              }}
              lsp={lspOptions}
              onOpenLocation={(path, range) => openAt(path, range.startLine)}
              minimap={editorPreferences.minimap}
              stickyScroll={editorPreferences.stickyScroll}
              editorConfig={activeEditorConfig}
              gitBaseline={gitAvailable ? activeGitBaseline : null}
              revealRange={revealRequest && revealRequest.path === activeFilePath && loadedPath === activeFilePath && !loading ? revealRequest : null}
            />
          )}
          {diskNotice ? <div aria-live="polite" className="codespace-disk-notice">{diskNotice}</div> : null}
          {activeTab || saveError || gitError ? (
            <WorkbenchStatusBar
              dirty={activeDirty}
              status={activeFilePath ? editorStatus : null}
              git={gitSummary}
              language={activeFilePath ? activeLanguage : null}
              encoding={activeBuffer?.encoding ?? null}
              notice={saveError ? `Save failed: ${saveError}` : gitError}
              languageServer={activeFilePath && !binary ? lspStatus : null}
              problems={lspProblems}
              onLanguageServerClick={onLanguageServerClick}
              onProblemsClick={() => editorApiRef.current?.showNextProblem()}
              onEndOfLineClick={() => editorApiRef.current?.setEndOfLine(editorStatus?.eol === "CRLF" ? "LF" : "CRLF")}
            />
          ) : null}
        </main>
      </div>
      {goToFileOpen ? (
        <GoToFilePalette
          rootDir={rootDir}
          files={files && !files.error ? files.files : null}
          truncated={Boolean(files?.truncated)}
          error={files?.error ?? null}
          recent={recentFiles}
          onClose={closeGoToFile}
          onOpen={(path, line) => {
            closeGoToFile();
            openAt(path, line);
          }}
        />
      ) : null}
      {pendingClose ? (
        <UnsavedChangesDialog
          paths={pendingClose.paths}
          rootDir={rootDir}
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
