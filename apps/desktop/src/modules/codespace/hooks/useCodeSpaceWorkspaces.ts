"use client";
import { useEffect, useState } from "react";
import { reapOrphanedSessions, reconcileSessions } from "@/lib/pty-session-controller";
import { loadKnownWorkspaces } from "@/lib/tauri/codespace";
import { useCodeSpaceLaunchFlow } from "@/modules/codespace/hooks/useCodeSpaceLaunchFlow";
import { useCodeSpaceWorkspaceManager } from "@/modules/codespace/hooks/useCodeSpaceWorkspaceManager";
import {
  loadPersistedCodeSpaceSnapshot,
  savePersistedCodeSpaceSnapshot,
} from "@/modules/codespace/services/workspace-metadata";

/**
 * The JS session registry is reaped once per window, not once per mount: leaving the workspace
 * surface and coming back is a remount, and must not touch sessions still in use.
 *
 * The Rust-side PTYs a reload leaves behind are not reaped here. That runs in Rust on page load
 * (`on_page_load` in lib.rs), before any surface can spawn. It used to be a
 * `close_window_sessions` call in this hook, which never ran after a reload into Canvas, and which
 * killed Canvas's live agents the first time Code mode mounted after one.
 *
 * Module scope is window scope here: each window loads its own copy of this module.
 */
let windowSessionsReaped = false;

/** Same scope as above: daemon sessions are matched to the restored panes once per window. */
let windowSessionsReconciled = false;

/**
 * How many surfaces currently own the workspaces.
 *
 * This hook is the snapshot's WRITER: it hydrates `workspaces` into its own `useState` and saves
 * the whole list back 400ms after any change. Two of them in one window are two writers of one
 * file, and the last save wins — a workspace opened in one surface disappears when the other
 * saves its older view. `AppShell` is what keeps this at one; the count is here so that if it
 * ever stops doing so, the reason is printed rather than inferred from lost work.
 */
let mountedOwners = 0;

/** Test seam: module state survives between tests in one file, and these are module-scoped. */
export function resetCodeSpaceWorkspaceOwnershipForTests(): void {
  windowSessionsReaped = false;
  windowSessionsReconciled = false;
  mountedOwners = 0;
}

export function useCodeSpaceWorkspaces() {
  const workspaceManager = useCodeSpaceWorkspaceManager();
  const launchFlow = useCodeSpaceLaunchFlow(workspaceManager.createWorkspace);
  const [metadataHydrated, setMetadataHydrated] = useState(false);
  const {
    activeWorkspaceId,
    focusedCellId,
    rememberKnownWorkspaces,
    restoreWorkspaceSnapshot,
    workspaces,
  } = workspaceManager;

  useEffect(() => {
    mountedOwners += 1;
    if (mountedOwners > 1) {
      console.error(
        "[codespace] two workspace owners are mounted in this window — the snapshot has two " +
          "writers and the last save wins. Exactly one of the shell (`/`) and CodeSpace " +
          "(`/terminal`) may be mounted at a time; see AppShell.",
      );
    }

    // Once per window, NOT once per mount: see `windowSessionsReaped`.
    if (!windowSessionsReaped) {
      windowSessionsReaped = true;
      reapOrphanedSessions();
    }

    return () => {
      mountedOwners -= 1;
    };
  }, []);

  // Closed workspaces too: a folder reopened later takes back its id, and with it its Lotus Tasks
  // and automations (they are keyed by workspace id).
  useEffect(() => {
    loadKnownWorkspaces()
      .then(rememberKnownWorkspaces)
      .catch((error) => {
        console.warn("[codespace] failed to load known workspaces:", error);
      });
  }, [rememberKnownWorkspaces]);

  useEffect(() => {
    let cancelled = false;

    loadPersistedCodeSpaceSnapshot()
      .then((snapshot) => {
        if (cancelled) return;
        if (snapshot && snapshot.workspaces.length > 0) {
          restoreWorkspaceSnapshot(snapshot);
        }
        // After the restore: a pane that is in the snapshot keeps its session for its terminal
        // to adopt. Not on a failed load (the catch below), where every pane would look gone.
        if (!windowSessionsReconciled) {
          windowSessionsReconciled = true;
          void reconcileSessions(
            (snapshot?.workspaces ?? []).flatMap((workspace) => workspace.cells.map((cell) => cell.id)),
          );
        }
      })
      .catch((error) => {
        console.warn("[codespace] failed to load persisted workspace metadata:", error);
      })
      .finally(() => {
        if (!cancelled) {
          setMetadataHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [restoreWorkspaceSnapshot]);

  useEffect(() => {
    if (!metadataHydrated) return;

    const timer = window.setTimeout(() => {
      void savePersistedCodeSpaceSnapshot({
        workspaces,
        activeWorkspaceId,
        focusedCellId,
      }).catch((error) => {
        console.warn("[codespace] failed to save workspace metadata:", error);
      });
    }, 400);

    return () => window.clearTimeout(timer);
  }, [
    metadataHydrated,
    activeWorkspaceId,
    focusedCellId,
    workspaces,
  ]);

  return {
    ...workspaceManager,
    ...launchFlow,
    handleSelectWorkspace: (id: string) => {
      launchFlow.handleCancelWizard();
      workspaceManager.handleSelectWorkspace(id);
    },
  };
}
