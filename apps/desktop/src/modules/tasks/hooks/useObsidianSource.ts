"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";
import {
  createTauriVaultClient,
  type TicketEditOutcome,
  type TicketEdits,
  type VaultTicketDetail,
} from "@/modules/tasks/services/vault-api";
import {
  toTrackerTaskFromTicket,
  VAULT_CAPABILITIES,
  VAULT_PROJECT_ID,
} from "@/modules/tasks/services/vault-mapping";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { TICKET_SOURCE_LABELS } from "@/modules/tasks/services/ticket-sources";
import { applyTrackerTaskPatch, restoreTrackerTask } from "@/modules/tasks/services/task-draft";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * The Obsidian vault as a ticket source: its project, its rows, and the one write it takes.
 *
 * Everything that knows a vault is a folder of markdown files lives here, so the board can hold it
 * beside the workspaces without asking "is this the vault?" anywhere else. A second kind of source
 * (Notion) is a second hook of the same shape, not new branches in the board.
 */
export interface ObsidianSource {
  /** Null when no vault is connected — the default, and not an error. */
  project: TrackerProject | null;
  tasks: TrackerTask[];
  /** Set when the folder could not be read. */
  error: string | null;
  /** Bumps whenever the folder changed on disk, so an open ticket can re-read itself. */
  version: number;
  refresh: () => void;
  open: (ref: string) => Promise<VaultTicketDetail | null>;
  /** A row's status or title, changed from the list. Resolves to the refusal, or null. */
  editRow: (original: TrackerTask, patch: Partial<Pick<TrackerTask, "title" | "status">>) => Promise<string | null>;
  /** The surgical edit of one ticket's page. Absent when no vault is connected. */
  saveTicket?: (file: string, baseRevision: string, edits: TicketEdits) => Promise<TicketEditOutcome>;
}

export function useObsidianSource(vaultPath: string): ObsidianSource {
  const vaultClient = useMemo(() => createTauriVaultClient(), []);
  const [tasks, setTasks] = useState<TrackerTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState(false);
  const [nonce, setNonce] = useState(0);

  /*
    The vault is read on its OWN, so a change in it reloads only itself.

    Sharing one effect with the workspaces would mean every ticket somebody edits in Obsidian
    re-reads every workspace's task file and blinks a list that did not change — and the vault is
    the one source here that changes without anybody in this window doing anything.
  */
  useEffect(() => {
    if (!vaultPath) {
      setTasks([]);
      setError(null);
      setRead(false);
      return;
    }

    let cancelled = false;
    void vaultClient
      .list(vaultPath)
      .then((tickets) => {
        if (cancelled) return;
        setTasks(tickets.map(toTrackerTaskFromTicket));
        setError(null);
        setRead(true);
      })
      .catch(() => {
        if (cancelled) return;
        setTasks([]);
        setError("The vault could not be read.");
        setRead(true);
      });

    return () => {
      cancelled = true;
    };
  }, [vaultClient, vaultPath, nonce]);

  /*
    Watch the folder, and re-read it when it moves.

    `unlisten` from Tauri is a PROMISE, not a function — awaiting it in cleanup is how the
    rejected-promise TypeError from a dead registry is avoided, and that one does not get caught
    by a try/catch around the call.
  */
  useEffect(() => {
    if (!isTauri()) return;
    void tauriInvoke("vault_watch", { vaultPath }).catch(() => {
      /* nothing to watch is not an error worth showing here */
    });

    let disposed = false;
    const pending = listen("vault://changed", () => setNonce((value) => value + 1));

    return () => {
      disposed = true;
      void pending.then((off) => {
        if (disposed) off();
      });
    };
  }, [vaultPath]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  /*
    One project, and it brings its OWN vocabulary and its own name. No prefix: its tickets carry
    their keys themselves (`TKT-987`, and two that carry none), so a project prefix here would print
    `TKT-?` over a ticket that is not an TKT.
  */
  const project = useMemo<TrackerProject | null>(() => {
    if (!vaultPath) return null;
    const label = TICKET_SOURCE_LABELS.obsidian;
    return {
      id: VAULT_PROJECT_ID,
      name: vaultFolderName(vaultPath),
      prefix: "",
      vocabulary: VAULT_VOCABULARY,
      capabilities: VAULT_CAPABILITIES,
      source: {
        kind: "obsidian",
        syncLine: !read
          ? `${label} · reading…`
          : error
            ? `${label} · could not be read`
            : `${label} · watching folder`,
      },
    };
  }, [error, read, vaultPath]);

  const open = useCallback(
    async (ref: string) => (vaultPath ? vaultClient.get(vaultPath, ref) : null),
    [vaultClient, vaultPath],
  );

  const saveTicket = useCallback(
    async (file: string, baseRevision: string, edits: TicketEdits): Promise<TicketEditOutcome> => {
      if (!vaultPath) throw new Error("No vault is connected.");
      const outcome = await vaultClient.edit(vaultPath, file, baseRevision, edits);
      if (outcome.kind === "saved") {
        // The row follows at once; the watcher's re-read of the folder confirms it a moment later.
        const row = toTrackerTaskFromTicket(outcome.detail.ticket);
        setTasks((current) => current.map((task) => (task.id === row.id ? row : task)));
      }
      return outcome;
    },
    [vaultClient, vaultPath],
  );

  /*
    A vault row, changed from the list. The row holds no revision — it is a summary — so the ticket
    is read first and the edit is made against what the file says NOW. A conflict means Obsidian
    or a pull got there in between: nothing was written, and the row shows the file as it is.
  */
  const editRow = useCallback(
    async (original: TrackerTask, patch: Partial<Pick<TrackerTask, "title" | "status">>): Promise<string | null> => {
      const edits: TicketEdits = {};
      if (patch.status !== undefined) edits.status = patch.status;
      if (patch.title !== undefined) edits.title = patch.title;
      if (!edits.status && !edits.title) return null;

      const showTicket = (ticket: VaultTicketDetail["ticket"]) => {
        const row = toTrackerTaskFromTicket(ticket);
        setTasks((current) => current.map((task) => (task.id === row.id ? row : task)));
      };
      setTasks((current) => applyTrackerTaskPatch(current, original.id, patch, Date.now()));
      try {
        const fresh = await vaultClient.get(vaultPath, original.id);
        if (!fresh) throw new Error("the ticket is no longer in the vault");
        const outcome = await vaultClient.edit(vaultPath, original.id, fresh.revision, edits);
        showTicket(outcome.detail.ticket);
        if (outcome.kind === "conflict") {
          return "That ticket changed in Obsidian a moment ago, so nothing was written. Try again.";
        }
        return null;
      } catch (cause) {
        setTasks((current) => restoreTrackerTask(current, original));
        return `That change was not saved: ${String(cause)}`;
      }
    },
    [vaultClient, vaultPath],
  );

  return useMemo(
    () => ({
      project,
      tasks,
      error,
      version: nonce,
      refresh,
      open,
      editRow,
      saveTicket: vaultPath ? saveTicket : undefined,
    }),
    [editRow, error, nonce, open, project, refresh, saveTicket, tasks, vaultPath],
  );
}

/** The folder's own name — what a person calls the vault, not the path they typed to reach it. */
function vaultFolderName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}
