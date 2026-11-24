import type { FileLink } from "@/lib/file-link";

export type WorkbenchOpenRequest = { path: string; startLine?: number; endLine?: number };
export type FileLinkOpenResult = { ok: true } | { ok: false; reason: string };

/*
 * Two hops, both outside React state on purpose:
 * 1. A Thread pane asks its workspace to open a file link (`openFileLinkInWorkspace`); the
 *    workspace shell answers (`onFileLinkOpen`) because only it knows the panes.
 * 2. The shell hands the file to one Editor pane (`requestWorkbenchOpen`). The request is kept
 *    until that pane takes it, so a pane created for the link picks it up when it mounts.
 */

const pendingOpens = new Map<string, WorkbenchOpenRequest>();
const openListeners = new Map<string, Set<() => void>>();

export function requestWorkbenchOpen(cellId: string, request: WorkbenchOpenRequest): void {
  pendingOpens.set(cellId, request);
  for (const listener of openListeners.get(cellId) ?? []) listener();
}

export function takeWorkbenchOpen(cellId: string): WorkbenchOpenRequest | null {
  const request = pendingOpens.get(cellId) ?? null;
  pendingOpens.delete(cellId);
  return request;
}

export function onWorkbenchOpen(cellId: string, listener: () => void): () => void {
  const listeners = openListeners.get(cellId) ?? new Set();
  listeners.add(listener);
  openListeners.set(cellId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) openListeners.delete(cellId);
  };
}

type FileLinkHandler = (workspaceId: string, link: FileLink) => FileLinkOpenResult;
let fileLinkHandler: FileLinkHandler | null = null;

export function onFileLinkOpen(handler: FileLinkHandler): () => void {
  fileLinkHandler = handler;
  return () => {
    if (fileLinkHandler === handler) fileLinkHandler = null;
  };
}

export const NO_EDITOR_PANE_REASON = "Files open in an Editor pane. There is none in this view.";

export function openFileLinkInWorkspace(workspaceId: string, link: FileLink): FileLinkOpenResult {
  if (!fileLinkHandler) return { ok: false, reason: NO_EDITOR_PANE_REASON };
  return fileLinkHandler(workspaceId, link);
}

/*
 * Split right: an Editor pane asks for its file in a new Editor pane beside it. Only the
 * workspace shell can add a pane, so it answers, and only for the panes it holds: an Editor in
 * another surface (the CodeSpace grid) has no split.
 */
type EditorSplitHandler = {
  holds: (cellId: string) => boolean;
  split: (sourceCellId: string, path: string) => void;
};
let editorSplitHandler: EditorSplitHandler | null = null;

export function onEditorSplit(handler: EditorSplitHandler): () => void {
  editorSplitHandler = handler;
  return () => {
    if (editorSplitHandler === handler) editorSplitHandler = null;
  };
}

/** Asked when it matters (the menu opens, the key is pressed): the shell can mount after the pane. */
export function canSplitEditor(cellId: string): boolean {
  return editorSplitHandler?.holds(cellId) ?? false;
}

/** False when no shell can split this pane, so the caller can leave the key alone. */
export function requestEditorSplit(sourceCellId: string, path: string): boolean {
  if (!editorSplitHandler?.holds(sourceCellId)) return false;
  editorSplitHandler.split(sourceCellId, path);
  return true;
}
