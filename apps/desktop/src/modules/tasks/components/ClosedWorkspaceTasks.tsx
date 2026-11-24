"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FolderInput } from "lucide-react";
import {
  createTauriClosedWorkspaceTaskClient,
  describeMove,
  shortWorkspaceId,
  type ClosedWorkspaceTaskClient,
  type OrphanTaskFile,
} from "@/modules/tasks/services/closed-workspace-tasks";

/**
 * Tasks left behind by workspaces that are not open, and the one click that brings them back.
 *
 * Nothing links a pre-fix workspace id to its folder, so this never guesses a home: it shows what
 * is in each file and lets the user pick. It renders nothing at all when there is nothing to
 * recover, which is the normal case once the old files have been moved.
 */

export interface ClosedWorkspaceTasksProps {
  /** The open workspaces — both what "closed" is measured against and where tasks can go. */
  projects: readonly { id: string; name: string }[];
  client?: ClosedWorkspaceTaskClient;
  /** The board re-reads, so moved tasks show up under their new keys. */
  onMoved: () => void;
}

export function ClosedWorkspaceTasks({
  projects,
  client: injected,
  onMoved,
}: ClosedWorkspaceTasksProps) {
  const client = useMemo(() => injected ?? createTauriClosedWorkspaceTaskClient(), [injected]);
  const [files, setFiles] = useState<readonly OrphanTaskFile[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The file whose Delete waits for a second, explicit click. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  // The keyboard follows the confirm in and, when it is backed out of, returns to that row's Delete.
  const confirmButton = useRef<HTMLButtonElement>(null);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (confirming) {
      confirmButton.current?.focus();
    } else if (refocus.current) {
      deleteButtons.current.get(refocus.current)?.focus();
      refocus.current = null;
    }
  }, [confirming]);
  const cancelDelete = (workspaceId: string) => {
    refocus.current = workspaceId;
    setConfirming(null);
  };

  // Keyed by the ids, not the array: the board hands a new array on every render.
  const openIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const openKey = openIds.join("\u0000");

  const reload = useCallback(async () => {
    try {
      setFiles(await client.list(openIds));
    } catch {
      // Outside Tauri, or the folder cannot be read: there is nothing this section can offer.
      setFiles([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openKey stands for openIds
  }, [client, openKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const move = async (file: OrphanTaskFile) => {
    const to = targets[file.workspaceId] ?? projects[0]?.id;
    if (!to) return;
    setBusy(file.workspaceId);
    setNotice(null);
    try {
      const result = await client.move(file.workspaceId, to);
      const name = projects.find((p) => p.id === to)?.name ?? to;
      setNotice(describeMove(result, name));
      onMoved();
      await reload();
    } catch (cause) {
      setNotice(`Could not move ${shortWorkspaceId(file.workspaceId)}: ${String(cause)}`);
    } finally {
      setBusy(null);
    }
  };

  /** Runs one change to a file, then re-reads the list; a failure says why. */
  const act = async (file: OrphanTaskFile, change: () => Promise<string | null>) => {
    setBusy(file.workspaceId);
    setNotice(null);
    setConfirming(null);
    try {
      setNotice(await change());
    } catch (cause) {
      setNotice(`Could not change ${shortWorkspaceId(file.workspaceId)}: ${String(cause)}`);
    } finally {
      // Also after a failure: part of a change may have landed, and the rows must show the disk.
      await reload();
      setBusy(null);
    }
  };

  const setIgnored = (file: OrphanTaskFile, ignored: boolean) =>
    act(file, async () => {
      await client.setIgnored(file.workspaceId, ignored);
      return null;
    });

  const remove = (file: OrphanTaskFile) =>
    act(file, async () => {
      await client.remove(file.workspaceId, openIds);
      return `Deleted ${file.taskCount} tasks from ${shortWorkspaceId(file.workspaceId)}`;
    });

  const ignoredCount = files.filter((f) => f.ignored).length;
  const shown = files.filter((f) => showIgnored || !f.ignored);

  if (files.length === 0 && !notice) return null;

  return (
    <section className="tk-orphans" aria-label="From closed workspaces">
      <p className="tk-nav-section">From closed workspaces</p>
      {shown.map((file) => {
        const short = shortWorkspaceId(file.workspaceId);
        return (
          <div
            key={file.workspaceId}
            className={file.ignored ? "tk-orphan tk-orphan--ignored" : "tk-orphan"}
            title={file.workspaceId}
          >
            <div className="tk-orphan-head">
              <FolderInput size={14} strokeWidth={1.75} aria-hidden />
              <span className="tk-nav-label">{short}</span>
              <span className="tk-nav-count">
                {file.openCount} open of {file.taskCount}
              </span>
            </div>
            {file.sampleTitles.length > 0 ? (
              <ul className="tk-orphan-titles">
                {file.sampleTitles.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
            ) : null}
            {projects.length > 0 ? (
              <div className="tk-orphan-move">
                <select
                  aria-label={`Move tasks from ${short} into`}
                  className="tk-orphan-select"
                  value={targets[file.workspaceId] ?? projects[0]?.id}
                  onChange={(event) =>
                    setTargets((prev) => ({ ...prev, [file.workspaceId]: event.target.value }))
                  }
                  disabled={busy !== null}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="tk-orphan-button"
                  onClick={() => void move(file)}
                  disabled={busy !== null}
                >
                  Move
                </button>
              </div>
            ) : null}
            {confirming === file.workspaceId ? (
              <div
                className="tk-orphan-confirm"
                role="group"
                aria-label={`Delete ${short}`}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.key === "Escape") cancelDelete(file.workspaceId);
                }}
              >
                <p>
                  Delete all {file.taskCount} tasks from {short}?
                </p>
                <button
                  ref={confirmButton}
                  type="button"
                  className="tk-orphan-button tk-orphan-button--danger"
                  onClick={() => void remove(file)}
                  disabled={busy !== null}
                >
                  Delete {file.taskCount} tasks
                </button>
                <button
                  type="button"
                  className="tk-orphan-button"
                  onClick={() => cancelDelete(file.workspaceId)}
                  disabled={busy !== null}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="tk-orphan-actions">
                <button
                  type="button"
                  className="tk-orphan-link"
                  onClick={() => void setIgnored(file, !file.ignored)}
                  disabled={busy !== null}
                  title={
                    file.ignored
                      ? undefined
                      : "Hide from this list. The tasks stay on disk and return if the workspace is reopened."
                  }
                >
                  {file.ignored ? "Unignore" : "Ignore"}
                </button>
                <button
                  ref={(button) => {
                    if (button) deleteButtons.current.set(file.workspaceId, button);
                    else deleteButtons.current.delete(file.workspaceId);
                  }}
                  type="button"
                  className="tk-orphan-link tk-orphan-link--danger"
                  onClick={() => setConfirming(file.workspaceId)}
                  disabled={busy !== null}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        );
      })}
      {ignoredCount > 0 ? (
        <button
          type="button"
          className="tk-orphan-link tk-orphan-toggle"
          onClick={() => setShowIgnored((on) => !on)}
          aria-expanded={showIgnored}
        >
          {showIgnored ? `Hide ignored (${ignoredCount})` : `Show ignored (${ignoredCount})`}
        </button>
      ) : null}
      {notice ? (
        <p className="tk-orphan-notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
