"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, Copy, FilePlus, FolderOpen, FolderPlus, LocateFixed, Minus, PanelLeftClose, Pencil, Plus, RefreshCw, Search, SendHorizontal, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatRemoteError, parseRemoteError } from "@/lib/tauri/remote-error";

const describeError = (err: unknown) => formatRemoteError(parseRemoteError(err));
import type { CodespaceGitFileStatus, EditorListEntry } from "@/lib/tauri-api";
import { resolveWorkbenchFileIcon, resolveWorkbenchFolderIcon } from "@/modules/codespace/services/file-icon-theme";
import {
  buildTree,
  gitStatusLabel,
  gitStatusTone,
  searchTree,
  toRelative,
  type DeleteDraft,
  type TreeNode,
} from "./file-tree-nodes";
import { PATH_QUERY_DEBOUNCE_MS } from "@/modules/codespace/services/fuzzy-path";
import { FileTreeContextMenu, type FileTreeMenuCloseReason, type FileTreeMenuItem } from "./FileTreeContextMenu";

interface FileTreeProps {
  rootDir: string;
  entries: EditorListEntry[];
  activeFilePath: string | null;
  gitStatusByPath?: Map<string, CodespaceGitFileStatus>;
  onStageFile?: (filePath: string) => void;
  onUnstageFile?: (filePath: string) => void;
  onCollapse?: () => void;
  /** Absolute paths with unsaved edits; the delete confirmation warns about them. */
  unsavedPaths?: readonly string[];
  /**
   * Folders whose children are in `entries`. With `onLoadDirectory`, the tree asks for a folder
   * the first time it is shown open, so a large repo is read one folder at a time.
   */
  loadedDirectories?: ReadonlySet<string>;
  loadingDirectories?: ReadonlySet<string>;
  /** Folders whose listing stopped at the 10,000-entry cap; a note under their last row says so. */
  truncatedDirectories?: ReadonlySet<string>;
  onLoadDirectory?: (absoluteDirPath: string) => void;
  /** A filter was started; the parent may read the file index to search in. */
  onSearchStart?: () => void;
  /** Every file in the workspace, for the filter; `null` while it is being read (the loaded rows are searched meanwhile). */
  searchFiles?: readonly string[] | null;
  /** Files in the workspace; `null` hides the count (a lazy tree does not know it). */
  fileCount?: number | null;
  onCreateFile?: (relativePath: string) => Promise<void> | void;
  onCreateFolder?: (relativePath: string) => Promise<void> | void;
  onDeleteEntry?: (relativePath: string, kind: "file" | "directory") => Promise<void> | void;
  /** Offered → F2 renames the row in place. Both paths are relative to `rootDir`. */
  onRenameEntry?: (fromRelativePath: string, toRelativePath: string, kind: "file" | "directory") => Promise<void> | void;
  /** Offered (local workspaces) → "Reveal in Finder" in the row menu. */
  onRevealEntry?: (relativePath: string) => Promise<void> | void;
  /** Offered → "Send to Thread" in the row menu: the path goes into a Thread's composer. */
  onSendEntryToThread?: (relativePath: string, kind: "file" | "directory") => void;
  /** A new nonce starts New file / New folder as the toolbar button would (launcher, ⌥⌘N). */
  createRequest?: { kind: "file" | "folder"; nonce: number } | null;
  /** A new value reveals the active file (the palette's "Reveal in tree"). */
  revealActiveRequest?: number;
  onRefresh?: () => Promise<void> | void;
  /** `preview`: a single click, so the tab is replaced by the next one (double-click or Enter keeps it). */
  onOpenFile: (filePath: string, options: { preview: boolean }) => void;
}

// Rows are a fixed height (`.codespace-workbench-tree-row`), so the visible slice is plain arithmetic.
// 22px, as VS Code's explorer.
export const FILE_TREE_ROW_HEIGHT = 22;
const ROW_HEIGHT = FILE_TREE_ROW_HEIGHT;
const DELETE_ROW_HEIGHT = 80;
const DELETE_ROW_WARNING_HEIGHT = 98;
/** A new-name field with its error line under it. */
const CREATE_ROW_ERROR_HEIGHT = 40;
const OVERSCAN_ROWS = 8;
/** Used until the scroll box has been measured, and in tests, where nothing has a size. */
const FALLBACK_VIEWPORT_HEIGHT = 800;
// A stable default: a fresh `[]` each render would rebuild every row on every scroll.
const NO_UNSAVED_PATHS: readonly string[] = [];
/** Hits shown by a filter. More than Go to file's 50: a tree has room, and folders group them. */
const FILTER_RESULT_LIMIT = 500;

type TreeRow =
  | {
    kind: "node";
    key: string;
    node: TreeNode;
    depth: number;
    parentPath: string | null;
    position: number;
    setSize: number;
    expanded: boolean;
  }
  | { kind: "loading"; key: string; depth: number }
  | { kind: "truncated"; key: string; depth: number }
  | { kind: "delete"; key: string; node: TreeNode; depth: number }
  | { kind: "create"; key: string; depth: number };

type NodeRow = Extract<TreeRow, { kind: "node" }>;

type RenameDraft = {
  relativePath: string;
  parentPath: string | null;
  kind: "file" | "directory";
  name: string;
  value: string;
  error: string | null;
  busy: boolean;
};

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function unsavedUnder(node: TreeNode, unsavedPaths: readonly string[]): string[] {
  const base = normalizeSlashes(node.absolutePath);
  return unsavedPaths.filter((path) => {
    const candidate = normalizeSlashes(path);
    return candidate === base || candidate.startsWith(`${base}/`);
  });
}

/** The row under `y`: the last one starting at or above it. */
function rowIndexAt(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= y) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

export function FileTree({
  rootDir,
  entries,
  activeFilePath,
  gitStatusByPath,
  onStageFile,
  onUnstageFile,
  onCollapse,
  unsavedPaths = NO_UNSAVED_PATHS,
  loadedDirectories,
  loadingDirectories,
  truncatedDirectories,
  onLoadDirectory,
  onSearchStart,
  searchFiles = null,
  fileCount: fileCountProp,
  onCreateFile,
  onCreateFolder,
  onDeleteEntry,
  onRenameEntry,
  onRevealEntry,
  onSendEntryToThread,
  createRequest = null,
  revealActiveRequest = 0,
  onRefresh,
  onOpenFile,
}: FileTreeProps) {
  const [query, setQuery] = useState("");
  // What the rows show: `query` once typing pauses.
  const [settledQuery, setSettledQuery] = useState("");
  const settleTimerRef = useRef<number | null>(null);
  // Folders closed by hand in the results. Kept apart, so clearing the filter gives back the
  // tree as it was, and a new query opens every folder above its hits again.
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set());
  // A new file or folder being named in place, as the first row inside `parentPath` ("" = root).
  const [createDraft, setCreateDraft] = useState<{
    kind: "file" | "folder";
    parentPath: string;
    value: string;
    error: string | null;
    busy: boolean;
  } | null>(null);
  const [deleteDraft, setDeleteDraft] = useState<DeleteDraft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** A short confirmation ("Copied path") that clears itself. */
  const [actionNote, setActionNote] = useState<string | null>(null);
  const actionNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (actionNoteTimer.current) clearTimeout(actionNoteTimer.current);
  }, []);
  const createInputRef = useRef<HTMLInputElement>(null);

  const unsavedPathSet = useMemo(() => new Set(unsavedPaths), [unsavedPaths]);
  const tree = useMemo(() => buildTree(rootDir, entries), [entries, rootDir]);
  const loadedFiles = useMemo(
    () => entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    [entries],
  );
  const searchMode = settledQuery.trim().length > 0;
  const filteredTree = useMemo(
    () => (searchMode ? searchTree(rootDir, settledQuery, searchFiles ?? loadedFiles, FILTER_RESULT_LIMIT) : tree),
    [loadedFiles, rootDir, searchFiles, searchMode, settledQuery, tree],
  );
  const fileCount = fileCountProp === undefined ? loadedFiles.length : fileCountProp;
  const activePathAncestors = useMemo(() => {
    if (!activeFilePath) return new Set<string>();
    const relativePath = toRelative(rootDir, activeFilePath).replace(/\\/g, "/");
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length <= 1) return new Set<string>();
    const paths = new Set<string>();
    let currentPath = "";
    for (const segment of segments.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      paths.add(currentPath);
    }
    return paths;
  }, [activeFilePath, rootDir]);

  const changeQuery = (next: string) => {
    setQuery(next);
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    const settle = () => {
      setSettledQuery(next);
      setSearchCollapsed(new Set());
    };
    // As Go to file: the first letter filters at once, later ones after a pause in typing.
    if (!settledQuery.trim() || !next.trim()) settle();
    else settleTimerRef.current = window.setTimeout(settle, PATH_QUERY_DEBOUNCE_MS);
  };
  useEffect(() => () => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
  }, []);

  const canCreate = Boolean(onCreateFile || onCreateFolder);

  const startCreate = (kind: "file" | "folder", parentPath = "") => {
    setActionError(null);
    setDeleteDraft(null);
    setRenameDraft(null);
    // A filtered tree has no stable folder for the field to sit in.
    changeQuery("");
    if (parentPath) {
      const ancestors = parentPath.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));
      setExpandedDirectories((previous) => new Set([...previous, ...ancestors]));
      setCollapsedDirectories((previous) => {
        const next = new Set(previous);
        for (const ancestor of ancestors) next.delete(ancestor);
        return next;
      });
    }
    setCreateDraft({ kind, parentPath, value: "", error: null, busy: false });
  };

  const cancelCreate = () => {
    if (!createDraft) return;
    const { parentPath } = createDraft;
    setCreateDraft(null);
    if (parentPath) requestFocus(parentPath);
  };

  const submitCreate = async () => {
    if (!createDraft || createDraft.busy) return;
    const name = createDraft.value.trim().replace(/^[/\\]+/, "");
    if (!name) {
      setCreateDraft({ ...createDraft, error: "Name required" });
      return;
    }
    if (name.split(/[\\/]/).some((segment) => segment === "..")) {
      setCreateDraft({ ...createDraft, error: "Use a path inside this workspace" });
      return;
    }

    const create = createDraft.kind === "file" ? onCreateFile : onCreateFolder;
    if (!create) return;

    const relativePath = createDraft.parentPath ? `${createDraft.parentPath}/${name}` : name;
    setCreateDraft({ ...createDraft, error: null, busy: true });
    try {
      await create(relativePath);
      setCreateDraft(null);
      // A new file opens in the editor, which keeps focus; a new folder takes it.
      if (createDraft.kind === "folder") requestFocus(relativePath);
      else setFocusedPath(relativePath);
    } catch (nextError) {
      setCreateDraft({
        ...createDraft,
        error: describeError(nextError),
        busy: false,
      });
    }
  };

  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null);
  // The row that holds the tree's one tab stop (roving tabindex), by relative path.
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>());
  // A row to move DOM focus to once it is rendered (it may be off screen until the next render).
  const pendingFocusRef = useRef<string | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  // Reveal active file: the row to scroll to once its parents are open and it is a row.
  const pendingRevealRef = useRef<string | null>(null);
  const [revealRequest, setRevealRequest] = useState(0);

  const requestFocus = useCallback((relativePath: string) => {
    setFocusedPath(relativePath);
    pendingFocusRef.current = relativePath;
    setFocusRequest((value) => value + 1);
  }, []);

  const isDirectoryExpanded = useCallback((relativePath: string) => {
    // A filter's tree holds only the folders above its hits, so each one shows open.
    if (searchMode) return !searchCollapsed.has(relativePath);
    if (collapsedDirectories.has(relativePath)) return false;
    return expandedDirectories.has(relativePath) || activePathAncestors.has(relativePath);
  }, [activePathAncestors, collapsedDirectories, expandedDirectories, searchCollapsed, searchMode]);

  const deleteDraftPath = deleteDraft?.relativePath ?? null;
  const createParentPath = createDraft?.parentPath ?? null;
  const createHasError = Boolean(createDraft?.error);
  // Unsaved paths only change a row's height while a delete confirmation is open.
  const deleteRowUnsaved = deleteDraftPath === null ? NO_UNSAVED_PATHS : unsavedPaths;
  const { rows, offsets } = useMemo(() => {
    const nextRows: TreeRow[] = [];
    const walk = (nodes: TreeNode[], depth: number, parentPath: string | null) => {
      nodes.forEach((node, index) => {
        const expanded = node.kind === "directory" && isDirectoryExpanded(node.relativePath);
        nextRows.push({
          kind: "node",
          key: node.id,
          node,
          depth,
          parentPath,
          position: index + 1,
          setSize: nodes.length,
          expanded,
        });
        if (deleteDraftPath === node.relativePath) {
          nextRows.push({ kind: "delete", key: `delete:${node.id}`, node, depth });
        }
        if (node.kind !== "directory" || !expanded) return;
        if (createParentPath === node.relativePath) {
          nextRows.push({ kind: "create", key: `create:${node.id}`, depth: depth + 1 });
        }
        if (node.children.length === 0 && loadingDirectories?.has(node.absolutePath)) {
          nextRows.push({ kind: "loading", key: `loading:${node.id}`, depth: depth + 1 });
        }
        walk(node.children, depth + 1, node.relativePath);
        // A filter searches the full index, so a cut listing does not limit what it shows.
        if (!searchMode && truncatedDirectories?.has(node.absolutePath)) {
          nextRows.push({ kind: "truncated", key: `truncated:${node.id}`, depth: depth + 1 });
        }
      });
    };
    if (createParentPath === "") nextRows.push({ kind: "create", key: "create:__root__", depth: 0 });
    walk(filteredTree, 0, null);
    if (!searchMode && truncatedDirectories?.has(rootDir)) nextRows.push({ kind: "truncated", key: "truncated:__root__", depth: 0 });

    const nextOffsets = [0];
    for (const row of nextRows) {
      const height = row.kind === "delete"
        ? unsavedUnder(row.node, deleteRowUnsaved).length > 0 ? DELETE_ROW_WARNING_HEIGHT : DELETE_ROW_HEIGHT
        : row.kind === "create" && createHasError ? CREATE_ROW_ERROR_HEIGHT : ROW_HEIGHT;
      nextOffsets.push(nextOffsets[nextOffsets.length - 1] + height);
    }
    return { rows: nextRows, offsets: nextOffsets };
  }, [createHasError, createParentPath, deleteDraftPath, deleteRowUnsaved, filteredTree, isDirectoryExpanded, loadingDirectories, rootDir, searchMode, truncatedDirectories]);

  const viewport = viewportHeight || FALLBACK_VIEWPORT_HEIGHT;
  const focusedIndex = focusedPath === null
    ? -1
    : rows.findIndex((row) => row.kind === "node" && row.node.relativePath === focusedPath);
  const tabStopIndex = focusedIndex >= 0 ? focusedIndex : rows.length > 0 ? 0 : -1;

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () => setViewportHeight(scroller.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const path = pendingFocusRef.current;
    if (path === null) return;
    const element = rowElementsRef.current.get(path);
    if (!element) return;
    pendingFocusRef.current = null;
    element.focus({ preventScroll: true });
  }, [focusRequest, rows]);

  useLayoutEffect(() => {
    const path = pendingRevealRef.current;
    if (path === null) return;
    const index = rows.findIndex((row) => row.kind === "node" && row.node.relativePath === path);
    if (index < 0) return;
    pendingRevealRef.current = null;
    focusRow(index);
    // focusRow reads this render's rows and offsets, which is what the effect sees.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest, rows]);

  const createKey = createDraft ? `${createDraft.kind}:${createDraft.parentPath}` : null;
  useLayoutEffect(() => {
    if (!createKey) return;
    const index = rows.findIndex((row) => row.kind === "create");
    if (index >= 0) scrollRowIntoView(index);
    createInputRef.current?.focus();
    // Once per new field, not on every row change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createKey]);

  const deleteDraftOpen = deleteDraft !== null;
  useEffect(() => {
    if (deleteDraftOpen) deleteCancelRef.current?.focus();
  }, [deleteDraftOpen, deleteDraftPath]);

  const renamingPath = renameDraft?.relativePath ?? null;
  useEffect(() => {
    const input = renameInputRef.current;
    if (!renamingPath || !input) return;
    input.focus();
    // Select the name without its extension, as Finder and VS Code do.
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }, [renamingPath]);

  const scrollRowIntoView = (index: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top = offsets[index];
    const bottom = offsets[index + 1];
    let next = scroller.scrollTop;
    if (top < next) next = top;
    else if (bottom > next + viewport) next = bottom - viewport;
    if (next === scroller.scrollTop) return;
    scroller.scrollTop = next;
    setScrollTop(next);
  };

  const focusRow = (index: number) => {
    const row = rows[index];
    if (row?.kind !== "node") return;
    scrollRowIntoView(index);
    requestFocus(row.node.relativePath);
  };

  const nodeRowFrom = (index: number, step: 1 | -1): number => {
    for (let next = index + step; next >= 0 && next < rows.length; next += step) {
      if (rows[next].kind === "node") return next;
    }
    return -1;
  };

  const openDeletePopover = (node: TreeNode) => {
    setActionError(null);
    setCreateDraft(null);
    setRenameDraft(null);
    setFocusedPath(node.relativePath);
    setDeleteDraft({
      kind: node.kind,
      name: node.name,
      relativePath: node.relativePath,
      busy: false,
    });
  };

  const closeDeletePopover = () => {
    if (!deleteDraft) return;
    const path = deleteDraft.relativePath;
    setDeleteDraft(null);
    requestFocus(path);
  };

  const confirmDelete = async () => {
    if (!onDeleteEntry || !deleteDraft || deleteDraft.busy) return;
    setActionError(null);
    setDeleteDraft({ ...deleteDraft, busy: true });
    const index = rows.findIndex((row) => row.kind === "node" && row.node.relativePath === deleteDraft.relativePath);
    const neighbour = rows[nodeRowFrom(index, -1)] ?? rows[nodeRowFrom(index, 1)];
    try {
      await onDeleteEntry(deleteDraft.relativePath, deleteDraft.kind);
      setDeleteDraft(null);
      if (neighbour?.kind === "node") requestFocus(neighbour.node.relativePath);
    } catch (nextError) {
      setActionError(describeError(nextError));
      setDeleteDraft({ ...deleteDraft, busy: false });
    }
  };

  const startRename = (row: NodeRow) => {
    setActionError(null);
    setCreateDraft(null);
    setDeleteDraft(null);
    setRenameDraft({
      relativePath: row.node.relativePath,
      parentPath: row.parentPath,
      kind: row.node.kind,
      name: row.node.name,
      value: row.node.name,
      error: null,
      busy: false,
    });
  };

  const cancelRename = () => {
    if (!renameDraft) return;
    const path = renameDraft.relativePath;
    setRenameDraft(null);
    requestFocus(path);
  };

  const submitRename = async () => {
    if (!renameDraft || renameDraft.busy || !onRenameEntry) return;
    const name = renameDraft.value.trim();
    if (!name) {
      setRenameDraft({ ...renameDraft, error: "Name required" });
      return;
    }
    if (/[\\/]/.test(name) || name === "." || name === "..") {
      setRenameDraft({ ...renameDraft, error: "Use a name, not a path" });
      return;
    }
    if (name === renameDraft.name) {
      cancelRename();
      return;
    }
    const toRelativePath = renameDraft.parentPath ? `${renameDraft.parentPath}/${name}` : name;
    setRenameDraft({ ...renameDraft, error: null, busy: true });
    try {
      await onRenameEntry(renameDraft.relativePath, toRelativePath, renameDraft.kind);
      setRenameDraft(null);
      requestFocus(toRelativePath);
    } catch (nextError) {
      setRenameDraft({ ...renameDraft, error: describeError(nextError), busy: false });
    }
  };

  const collapseAllDirectories = () => {
    if (searchMode) {
      const folders = new Set<string>();
      const walk = (nodes: TreeNode[]) => {
        for (const node of nodes) {
          if (node.kind !== "directory") continue;
          folders.add(node.relativePath);
          walk(node.children);
        }
      };
      walk(filteredTree);
      setSearchCollapsed(folders);
      return;
    }
    setExpandedDirectories(new Set());
    setCollapsedDirectories(new Set(
      entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => toRelative(rootDir, entry.path).replace(/\\/g, "/")),
    ));
  };

  const toggleDirectory = (relativePath: string) => {
    const expanded = isDirectoryExpanded(relativePath);
    if (searchMode) {
      setSearchCollapsed((previous) => {
        const next = new Set(previous);
        if (expanded) next.add(relativePath); else next.delete(relativePath);
        return next;
      });
      return;
    }
    setExpandedDirectories((previous) => {
      const next = new Set(previous);
      if (expanded) {
        next.delete(relativePath);
      } else {
        next.add(relativePath);
      }
      return next;
    });
    setCollapsedDirectories((previous) => {
      const next = new Set(previous);
      if (expanded) {
        next.add(relativePath);
      } else {
        next.delete(relativePath);
      }
      return next;
    });
  };

  const activateRow = (row: NodeRow, preview = false) => {
    if (row.node.kind === "file") onOpenFile(row.node.absolutePath, { preview });
    else toggleDirectory(row.node.relativePath);
  };

  // E17: ↑↓ move, → opens a folder then enters it, ← closes it then goes up, Enter opens,
  // F2 renames, Delete (⌘⌫ on a Mac keyboard) deletes. Home/End jump to the ends.
  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    if (event.target !== event.currentTarget) return;
    const row = rows[index];
    if (row?.kind !== "node") return;
    const { node } = row;
    switch (event.key) {
      case "ArrowDown":
        focusRow(nodeRowFrom(index, 1));
        break;
      case "ArrowUp":
        focusRow(nodeRowFrom(index, -1));
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows[rows.length - 1]?.kind === "node" ? rows.length - 1 : nodeRowFrom(rows.length, -1));
        break;
      case "ArrowRight":
        if (node.kind !== "directory") break;
        if (!row.expanded) {
          toggleDirectory(node.relativePath);
        } else {
          const child = nodeRowFrom(index, 1);
          if (child >= 0 && (rows[child] as NodeRow).parentPath === node.relativePath) focusRow(child);
        }
        break;
      case "ArrowLeft":
        if (node.kind === "directory" && row.expanded) {
          toggleDirectory(node.relativePath);
        } else if (row.parentPath !== null) {
          focusRow(rows.findIndex((candidate) => candidate.kind === "node" && candidate.node.relativePath === row.parentPath));
        }
        break;
      case "Enter":
        activateRow(row);
        break;
      case "F2":
        if (!onRenameEntry) return;
        startRename(row);
        break;
      case "Backspace":
        if (!event.metaKey || !onDeleteEntry) return;
        openDeletePopover(node);
        break;
      case "Delete":
        if (!onDeleteEntry) return;
        openDeletePopover(node);
        break;
      case "F10":
        if (!event.shiftKey) return;
        openMenuUnderRow(event.currentTarget, node.relativePath);
        break;
      case "ContextMenu":
        openMenuUnderRow(event.currentTarget, node.relativePath);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  /** The toolbar's New file / New folder: into the selected folder, beside the selected file. */
  const createTargetFolder = () => {
    const selected = focusedPath === null
      ? undefined
      : rows.find((row): row is NodeRow => row.kind === "node" && row.node.relativePath === focusedPath);
    if (!selected) return "";
    return selected.node.kind === "directory" ? selected.node.relativePath : selected.parentPath ?? "";
  };

  const openMenuUnderRow = (element: HTMLElement, relativePath: string) => {
    const rect = element.getBoundingClientRect();
    setMenu({ path: relativePath, x: rect.left + 24, y: rect.bottom });
  };

  const closeMenu = (reason: FileTreeMenuCloseReason) => {
    const path = menu?.path;
    setMenu(null);
    // An action that opens an input or a confirmation moves focus again after this.
    if (reason !== "outside" && path !== undefined) requestFocus(path);
  };

  const copyText = (value: string, what: string) => {
    setActionError(null);
    void copyTextToClipboard(value).then(
      () => {
        if (actionNoteTimer.current) clearTimeout(actionNoteTimer.current);
        setActionNote(`Copied ${what}`);
        actionNoteTimer.current = setTimeout(() => setActionNote(null), 1600);
      },
      // The raw DOMException ("NotAllowedError: The request is not allowed by the user agent…")
      // tells the user nothing they can act on.
      () => setActionError(`Couldn't copy the ${what} to the clipboard.`),
    );
  };

  const menuItemsFor = (row: NodeRow): FileTreeMenuItem[] => {
    const { node } = row;
    const inFolder = node.kind === "directory" ? node.relativePath : row.parentPath ?? "";
    const groups: Array<Array<Omit<FileTreeMenuItem, "groupStart">>> = [
      onSendEntryToThread
        ? [{
          id: "send-to-thread",
          label: "Send to Thread",
          icon: SendHorizontal,
          run: () => onSendEntryToThread(node.relativePath, node.kind === "directory" ? "directory" : "file"),
        }]
        : [],
      [
        ...(onCreateFile ? [{ id: "new-file", label: "New File", icon: FilePlus, run: () => startCreate("file", inFolder) }] : []),
        ...(onCreateFolder ? [{ id: "new-folder", label: "New Folder", icon: FolderPlus, run: () => startCreate("folder", inFolder) }] : []),
      ],
      [
        ...(onRenameEntry ? [{ id: "rename", label: "Rename", icon: Pencil, run: () => startRename(row) }] : []),
        ...(onDeleteEntry ? [{ id: "delete", label: "Delete", icon: Trash2, danger: true, run: () => openDeletePopover(node) }] : []),
      ],
      [
        { id: "copy-path", label: "Copy Path", icon: Copy, run: () => copyText(node.absolutePath, "path") },
        { id: "copy-relative-path", label: "Copy Relative Path", icon: Copy, run: () => copyText(node.relativePath, "relative path") },
      ],
      onRevealEntry
        ? [{
          id: "reveal",
          label: "Reveal in Finder",
          icon: FolderOpen,
          run: () => {
            void Promise.resolve(onRevealEntry(node.relativePath)).catch((err: unknown) => setActionError(describeError(err)));
          },
        }]
        : [],
    ];
    return groups
      .filter((group) => group.length > 0)
      .flatMap((group, groupIndex) => group.map((item, index) => ({ ...item, groupStart: groupIndex > 0 && index === 0 })));
  };

  const activeRelativePath = activeFilePath && normalizeSlashes(activeFilePath).startsWith(`${normalizeSlashes(rootDir)}/`)
    ? toRelative(rootDir, activeFilePath).replace(/\\/g, "/")
    : null;

  // E20: open the active file's folders again (even ones closed by hand) and scroll to it.
  const revealActiveFile = () => {
    if (!activeRelativePath) return;
    // The active file may not be a hit; show it in the whole tree.
    if (query) changeQuery("");
    setCollapsedDirectories((previous) => {
      const next = new Set(previous);
      for (const ancestor of activePathAncestors) next.delete(ancestor);
      return next;
    });
    pendingRevealRef.current = activeRelativePath;
    setRevealRequest((value) => value + 1);
  };

  // Requests from outside the tree act once per new value, not on mount with an old one.
  const createNonce = createRequest?.nonce ?? null;
  const seenCreateNonceRef = useRef(createNonce);
  useEffect(() => {
    if (createNonce === null || createNonce === seenCreateNonceRef.current || !createRequest) return;
    seenCreateNonceRef.current = createNonce;
    startCreate(createRequest.kind, createTargetFolder());
    // Keyed on the nonce alone: the handlers are rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createNonce]);

  const seenRevealRef = useRef(revealActiveRequest);
  useEffect(() => {
    if (revealActiveRequest === seenRevealRef.current) return;
    seenRevealRef.current = revealActiveRequest;
    revealActiveFile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealActiveRequest]);

  const renderDeleteRow = (row: Extract<TreeRow, { kind: "delete" }>, index: number) => {
    if (!deleteDraft) return null;
    const { node } = row;
    const lost = unsavedUnder(node, unsavedPaths);
    const lostLabel = lost.length === 1 ? lost[0].split(/[\\/]/).pop() : `${lost.length} files`;

    return (
      <div
        key={row.key}
        className="px-2 py-1"
        style={{ position: "absolute", left: 0, right: 0, top: offsets[index], height: offsets[index + 1] - offsets[index], paddingLeft: 8 + row.depth * 12 }}
      >
        <div
          className="rounded-md border border-red-200/14 bg-red-950/30 px-2 py-1.5 shadow-[0_8px_20px_rgba(0,0,0,0.22)]"
          role="dialog"
          aria-label={`Delete ${node.name} confirmation`}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || deleteDraft.busy) return;
            event.preventDefault();
            closeDeletePopover();
          }}
        >
          <p className="truncate text-[11px] font-medium text-red-50/90">
            Delete {node.kind === "directory" ? "folder" : "file"}?
          </p>
          <p className="mt-0.5 truncate text-[11px] text-red-100/58">
            {node.relativePath}
          </p>
          {lost.length > 0 ? (
            <p className="mt-1 text-[11px] font-medium text-amber-200/90">
              Unsaved edits in {lostLabel} will be lost.
            </p>
          ) : null}
          <div className="mt-1.5 flex items-center justify-end gap-1">
            <button
              ref={deleteCancelRef}
              type="button"
              onClick={closeDeletePopover}
              disabled={deleteDraft.busy}
              className="rounded border border-white/8 px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--codespace-panel-text-muted)] hover:bg-white/[0.045] hover:text-[color:var(--codespace-panel-text)] disabled:cursor-wait disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={deleteDraft.busy}
              className="rounded border border-red-200/22 bg-red-300/10 px-1.5 py-0.5 text-[11px] font-semibold text-red-50/88 hover:bg-red-300/16 disabled:cursor-wait disabled:opacity-45"
              aria-label={`Confirm delete ${node.name}`}
            >
              {deleteDraft.busy ? "Deleting" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderCreateRow = (row: Extract<TreeRow, { kind: "create" }>, index: number) => {
    if (!createDraft) return null;
    const isFile = createDraft.kind === "file";
    const typed = createDraft.value.trim();
    const icon = isFile
      ? resolveWorkbenchFileIcon(`${rootDir}/${typed || "untitled"}`)
      : resolveWorkbenchFolderIcon(`${rootDir}/${typed || "folder"}`, false);
    const label = isFile ? "New file name" : "New folder name";

    return (
      <div
        key={row.key}
        data-tree-row=""
        role="none"
        style={{ position: "absolute", left: 0, right: 0, top: offsets[index], height: offsets[index + 1] - offsets[index] }}
      >
        <div className="codespace-workbench-tree-row codespace-workbench-tree-row-muted">
          <span className="codespace-workbench-tree-button" style={{ paddingLeft: 8 + row.depth * 12 }}>
            <span aria-hidden="true" className="h-3 w-3 shrink-0" />
            <Image
              src={icon.src}
              alt=""
              aria-hidden="true"
              width={14}
              height={14}
              unoptimized
              className="codespace-workbench-file-icon"
              draggable={false}
            />
            <input
              ref={createInputRef}
              aria-label={label}
              aria-invalid={createDraft.error ? true : undefined}
              aria-describedby={createDraft.error ? "codespace-filetree-create-error" : undefined}
              value={createDraft.value}
              disabled={createDraft.busy}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setCreateDraft({ ...createDraft, value: event.target.value, error: null })}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitCreate();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelCreate();
                }
              }}
              onBlur={() => {
                if (!createDraft.busy && !createDraft.value.trim()) setCreateDraft(null);
              }}
              className="codespace-filetree-inline-input"
            />
          </span>
        </div>
        {createDraft.error ? (
          <p
            id="codespace-filetree-create-error"
            role="alert"
            className="codespace-filetree-inline-error"
            style={{ paddingLeft: 8 + row.depth * 12 + 37 }}
          >
            {createDraft.error}
          </p>
        ) : null}
      </div>
    );
  };

  const renderNodeRow = (row: NodeRow, index: number) => {
    const { node, depth } = row;
    const path = node.relativePath;
    const isFile = node.kind === "file";
    const active = isFile && node.absolutePath === activeFilePath;
    const gitStatus = isFile ? gitStatusByPath?.get(node.absolutePath) ?? null : null;
    const statusLabel = gitStatus ? gitStatusLabel(gitStatus) : "";
    const unsaved = isFile && unsavedPathSet.has(node.absolutePath);
    const icon = isFile
      ? resolveWorkbenchFileIcon(node.absolutePath)
      : resolveWorkbenchFolderIcon(node.absolutePath, row.expanded);
    const ChevronIcon = row.expanded ? ChevronDown : ChevronRight;
    const renaming = renameDraft?.relativePath === path;
    const loading = !isFile && row.expanded && Boolean(loadingDirectories?.has(node.absolutePath));

    return (
      <div
        key={row.key}
        ref={(element) => {
          if (!element) return;
          rowElementsRef.current.set(path, element);
          return () => {
            if (rowElementsRef.current.get(path) === element) rowElementsRef.current.delete(path);
          };
        }}
        role="treeitem"
        aria-label={node.name}
        aria-level={depth + 1}
        aria-posinset={row.position}
        aria-setsize={row.setSize}
        aria-expanded={isFile ? undefined : row.expanded}
        aria-selected={index === tabStopIndex}
        aria-busy={loading ? true : undefined}
        aria-current={active ? "page" : undefined}
        tabIndex={index === tabStopIndex ? 0 : -1}
        className={cn(
          "codespace-workbench-tree-row group",
          isFile && "codespace-workbench-tree-file-row",
          active ? "codespace-workbench-tree-row-active" : "codespace-workbench-tree-row-muted",
        )}
        data-active={active ? "true" : undefined}
        data-ignored={node.ignored ? "true" : undefined}
        style={{ position: "absolute", left: 0, right: 0, top: offsets[index] }}
        onClick={() => {
          if (renaming) return;
          setFocusedPath(path);
          activateRow(row, true);
        }}
        onDoubleClick={() => {
          if (renaming || !isFile) return;
          activateRow(row);
        }}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocusedPath(path);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (renaming) return;
          setFocusedPath(path);
          setMenu({ path, x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => handleRowKeyDown(event, index)}
      >
        <span className="codespace-workbench-tree-button" style={{ paddingLeft: 8 + depth * 12 }}>
          {isFile ? (
            <span aria-hidden="true" className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronIcon aria-hidden="true" className="h-3 w-3 shrink-0 text-[color:var(--codespace-panel-text-quiet)]" />
          )}
          <Image
            src={icon.src}
            alt=""
            aria-hidden="true"
            width={14}
            height={14}
            unoptimized
            className="codespace-workbench-file-icon"
            draggable={false}
          />
          {renaming && renameDraft ? (
            <input
              ref={renameInputRef}
              aria-label={`Rename ${node.name}`}
              aria-invalid={renameDraft.error ? true : undefined}
              value={renameDraft.value}
              disabled={renameDraft.busy}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setRenameDraft({ ...renameDraft, value: event.target.value, error: null })}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              onBlur={() => {
                if (!renameDraft.busy && !renameDraft.error) setRenameDraft(null);
              }}
              className="codespace-filetree-inline-input"
            />
          ) : (
            <span className="truncate">{node.name}</span>
          )}
        </span>
        {unsaved ? <span className="codespace-workbench-tab-dirty" role="img" aria-label="Unsaved changes" /> : null}
        {statusLabel ? (
          <span className={cn("codespace-workbench-git-badge", gitStatus && gitStatusTone(gitStatus))}>
            {statusLabel}
          </span>
        ) : null}
        {gitStatus?.unstaged && onStageFile ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Stage ${node.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onStageFile(node.absolutePath);
            }}
            className="codespace-workbench-tree-action"
          >
            <Plus className="h-3 w-3" />
          </button>
        ) : null}
        {gitStatus?.staged && onUnstageFile ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Unstage ${node.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onUnstageFile(node.absolutePath);
            }}
            className="codespace-workbench-tree-action"
          >
            <Minus className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    );
  };

  const renderRow = (index: number) => {
    const row = rows[index];
    if (row.kind === "node") return renderNodeRow(row, index);
    if (row.kind === "delete") return renderDeleteRow(row, index);
    if (row.kind === "create") return renderCreateRow(row, index);
    if (row.kind === "truncated") {
      return (
        <div
          key={row.key}
          aria-hidden="true"
          className="codespace-workbench-tree-row codespace-workbench-tree-row-muted text-[11px] text-[color:var(--codespace-panel-text-quiet)]"
          style={{ position: "absolute", left: 0, right: 0, top: offsets[index], paddingLeft: 8 + row.depth * 12 + 16 }}
          title="Very large folder: Go to file (⌘P) searches the full index."
        >
          Showing the first 10,000 entries
        </div>
      );
    }
    return (
      <div
        key={row.key}
        aria-hidden="true"
        className="codespace-workbench-tree-row codespace-workbench-tree-row-muted text-[11px] text-[color:var(--codespace-panel-text-quiet)]"
        style={{ position: "absolute", left: 0, right: 0, top: offsets[index], paddingLeft: 8 + row.depth * 12 + 16 }}
      >
        Loading…
      </div>
    );
  };

  // Only the rows in view (plus overscan) are in the DOM. The tab stop, and a delete
  // confirmation under it, stay rendered while scrolled away so focus is never dropped.
  const renderedIndexes = (() => {
    if (rows.length === 0) return [];
    const first = Math.max(0, rowIndexAt(offsets, scrollTop) - OVERSCAN_ROWS);
    const last = Math.min(rows.length - 1, rowIndexAt(offsets, scrollTop + viewport) + OVERSCAN_ROWS);
    const indexes: number[] = [];
    for (let index = first; index <= last; index += 1) indexes.push(index);
    const createIndex = createDraft ? rows.findIndex((row) => row.kind === "create") : -1;
    for (const pinned of [tabStopIndex, tabStopIndex + 1, createIndex]) {
      if (pinned < 0 || pinned >= rows.length || (pinned >= first && pinned <= last) || indexes.includes(pinned)) continue;
      if (pinned === tabStopIndex || pinned === createIndex || rows[pinned].kind === "delete") indexes.push(pinned);
    }
    return indexes.sort((left, right) => left - right);
  })();

  // Open folders whose children were never read: the ones you opened, and the parents of the
  // active file. Not while filtering — every folder shows open then, and this would crawl the repo.
  const requestedDirectoriesRef = useRef(new Set<string>());
  const unloadedOpenDirectories: string[] = [];
  if (onLoadDirectory && loadedDirectories && !searchMode) {
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind !== "directory" || !isDirectoryExpanded(node.relativePath)) continue;
        if (!loadedDirectories.has(node.absolutePath)) unloadedOpenDirectories.push(node.absolutePath);
        walk(node.children);
      }
    };
    walk(filteredTree);
  }
  const unloadedKey = unloadedOpenDirectories.join("\n");
  useEffect(() => {
    // A request shows up as loading on the next render. One that is neither loading nor loaded
    // by now finished, or was dropped (the pane moved on), so the folder may be asked for again.
    for (const path of requestedDirectoriesRef.current) {
      if (!loadingDirectories?.has(path)) requestedDirectoriesRef.current.delete(path);
    }
    if (!onLoadDirectory || !unloadedKey) return;
    for (const path of unloadedKey.split("\n")) {
      if (loadingDirectories?.has(path) || requestedDirectoriesRef.current.has(path)) continue;
      requestedDirectoriesRef.current.add(path);
      onLoadDirectory(path);
    }
  }, [loadedDirectories, loadingDirectories, onLoadDirectory, unloadedKey]);

  return (
    <div className="codespace-filetree flex h-full min-h-0 flex-col">
      {/* One row, as VS Code's explorer: the folder's name, and its actions at the right. */}
      <div className="codespace-filetree-header">
        <p
          className="codespace-filetree-root-name"
          title={fileCount === null ? rootDir : `${rootDir} · ${fileCount.toLocaleString()} file${fileCount === 1 ? "" : "s"}`}
        >
          {rootDir.split(/[\\/]/).filter(Boolean).at(-1) ?? rootDir}
        </p>
        <div className="codespace-filetree-actions" role="toolbar" aria-label="File explorer actions">
          {canCreate ? (
            <>
              <button
                type="button"
                onClick={() => startCreate("file", createTargetFolder())}
                disabled={!onCreateFile}
                className="codespace-workbench-toolbar-button"
                aria-label="New file"
                title="New file"
              >
                <FilePlus className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => startCreate("folder", createTargetFolder())}
                disabled={!onCreateFolder}
                className="codespace-workbench-toolbar-button"
                aria-label="New folder"
                title="New folder"
              >
                <FolderPlus className="h-3 w-3" />
              </button>
            </>
          ) : null}
          {onRefresh ? (
            <button
              type="button"
              onClick={() => void onRefresh()}
              className="codespace-workbench-toolbar-button"
              aria-label="Refresh files"
              title="Refresh files"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          ) : null}
          {activeRelativePath ? (
            <button
              type="button"
              onClick={revealActiveFile}
              className="codespace-workbench-toolbar-button"
              aria-label="Reveal active file"
              title="Reveal active file"
            >
              <LocateFixed className="h-3 w-3" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={collapseAllDirectories}
            className="codespace-workbench-toolbar-button"
            aria-label="Collapse folders"
            title="Collapse folders"
          >
            <ChevronsDownUp className="h-3 w-3" />
          </button>
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              className="codespace-workbench-toolbar-button"
              aria-label="Hide sidebar"
              title="Hide sidebar"
            >
              <PanelLeftClose className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </div>
      {actionError ? (
        <div role="alert" className="flex items-start gap-1.5 border-b border-amber-200/10 px-2 py-1 text-[11px] text-amber-200/78">
          <span className="min-w-0 flex-1 break-words">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="grid h-4 w-4 shrink-0 place-items-center rounded text-amber-200/60 hover:bg-[color:var(--codespace-panel-surface-hover)] hover:text-amber-200"
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : actionNote ? (
        <div role="status" className="border-b border-[color:var(--codespace-panel-border)] px-2 py-1 text-[11px] text-[color:var(--codespace-panel-text-muted)]">
          {actionNote}
        </div>
      ) : null}
      {renameDraft?.error ? (
        <div role="alert" className="border-b border-amber-200/10 px-2 py-1 text-[11px] text-amber-200/78">
          {renameDraft.error}
        </div>
      ) : null}
      <div className="codespace-filetree-search-wrap">
        <div className="codespace-filetree-search">
          <Search className="h-3 w-3 shrink-0 text-[color:var(--codespace-panel-text-quiet)]" aria-hidden="true" />
          <input
            aria-label="Search files"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[color:var(--codespace-panel-text-quiet)]"
            placeholder="Search files"
            value={query}
            onChange={(event) => {
              if (!query.trim() && event.target.value.trim()) onSearchStart?.();
              changeQuery(event.target.value);
            }}
          />
          {query ? (
            <button
              type="button"
              onClick={() => changeQuery("")}
              className="grid h-4 w-4 shrink-0 place-items-center rounded text-[color:var(--codespace-panel-text-quiet)] hover:bg-[color:var(--codespace-panel-surface-hover)] hover:text-[color:var(--codespace-panel-text)]"
              aria-label="Clear file search"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="codespace-filetree-scroll min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          if (menu) setMenu(null);
        }}
      >
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-[color:var(--codespace-panel-text-muted)]">
            {searchMode ? "No matching files." : "No files in this workspace."}
          </div>
        ) : (
          <div
            role="tree"
            aria-label="Files"
            className="codespace-filetree-rows"
            style={{ position: "relative", height: offsets[rows.length] }}
          >
            {renderedIndexes.map(renderRow)}
          </div>
        )}
      </div>
      {(() => {
        if (!menu) return null;
        const row = rows.find((candidate): candidate is NodeRow => candidate.kind === "node" && candidate.node.relativePath === menu.path);
        if (!row) return null;
        return (
          <FileTreeContextMenu
            label={`Actions for ${row.node.name}`}
            items={menuItemsFor(row)}
            x={menu.x}
            y={menu.y}
            onClose={closeMenu}
          />
        );
      })()}
    </div>
  );
}
