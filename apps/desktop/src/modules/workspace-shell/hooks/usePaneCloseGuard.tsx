"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Workspace } from "@/modules/codespace/components/types";
import { UnsavedChangesDialog } from "@/modules/codespace/components/workbench/UnsavedChangesDialog";
import { saveUnsavedFiles, unsavedFilePaths } from "@/modules/codespace/services/unsaved-changes";

type PendingPaneClose = {
  workspaceId: string;
  cellId: string;
  rootDir: string;
  paths: string[];
  busy: boolean;
  error: string | null;
  onClosed?: () => void;
};

interface PaneCloseGuardOptions {
  workspaces: readonly Workspace[];
  removePane: (workspaceId: string, cellId: string) => void;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Every way a pane closes ends in `removePane`, which throws away Editor buffers. This asks
 * first when an Editor pane holds edits that are not on disk.
 */
export function usePaneCloseGuard({ workspaces, removePane }: PaneCloseGuardOptions) {
  const [pending, setPendingState] = useState<PendingPaneClose | null>(null);
  // Read by the close request, which can run again before the next render (a repeated ⌘W).
  const pendingRef = useRef<PendingPaneClose | null>(null);
  const setPending = useCallback((next: PendingPaneClose | null) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);
  // A save resolves after renders that may have replaced `removePane`; close with the current one.
  const removePaneRef = useRef(removePane);
  useEffect(() => {
    removePaneRef.current = removePane;
  }, [removePane]);

  const unsavedIn = useCallback((workspaceId: string, cellId: string) => {
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    const cell = workspace?.cells.find((candidate) => candidate.id === cellId);
    if (!workspace || cell?.type !== "workbench") return null;
    const paths = unsavedFilePaths(cell.tabs);
    return paths.length > 0 ? { workspace, cell, paths } : null;
  }, [workspaces]);

  const requestClosePane = useCallback((workspaceId: string, cellId: string, onClosed?: () => void) => {
    // One question at a time: a repeated ⌘W must not reset a save that is already running.
    if (pendingRef.current) return;
    const unsaved = unsavedIn(workspaceId, cellId);
    if (!unsaved) {
      onClosed?.();
      removePane(workspaceId, cellId);
      return;
    }
    setPending({
      workspaceId,
      cellId,
      rootDir: unsaved.cell.rootDir,
      paths: unsaved.paths,
      busy: false,
      error: null,
      onClosed,
    });
  }, [removePane, setPending, unsavedIn]);

  /** An agent cannot answer the dialog, so it is refused rather than allowed to lose work. */
  const closeForAgent = useCallback((workspaceId: string, cellId: string) => {
    const unsaved = unsavedIn(workspaceId, cellId);
    if (unsaved) {
      const names = unsaved.paths.map(fileName).join(", ");
      throw new Error(`pane ${cellId} has unsaved edits in ${names}; the user must save or discard them first`);
    }
    removePane(workspaceId, cellId);
  }, [removePane, unsavedIn]);

  const finish = useCallback((close: PendingPaneClose) => {
    setPending(null);
    close.onClosed?.();
    removePaneRef.current(close.workspaceId, close.cellId);
  }, [setPending]);

  const save = useCallback(async (close: PendingPaneClose) => {
    setPending({ ...close, busy: true, error: null });
    const workspace = workspaces.find((candidate) => candidate.id === close.workspaceId);
    const { failed } = await saveUnsavedFiles(close.paths, {
      location: workspace?.location ?? null,
      rootDir: close.rootDir,
    });
    if (failed) {
      setPending({ ...close, busy: false, error: `Could not save ${fileName(failed.path)}: ${failed.message}` });
      return;
    }
    finish(close);
  }, [finish, setPending, workspaces]);

  const dialog: ReactNode = pending ? (
    <UnsavedChangesDialog
      scope="window"
      paths={pending.paths}
      rootDir={pending.rootDir}
      busy={pending.busy}
      error={pending.error}
      onSave={() => void save(pending)}
      onDiscard={() => finish(pending)}
      onCancel={() => setPending(null)}
    />
  ) : null;

  return { requestClosePane, closeForAgent, dialog };
}
