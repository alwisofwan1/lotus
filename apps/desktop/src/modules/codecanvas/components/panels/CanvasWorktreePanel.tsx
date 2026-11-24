"use client";
import { useEffect, useState, useCallback } from "react";
import { X, GitBranch, RefreshCw, Plus, Minus, Trash2, SquareTerminal } from "lucide-react";
import type { WorktreeEntry } from "@/lib/tauri/canvas-git";
import { getActiveProjectLocation } from "../../services/canvas-active-project";
import { listWorktreesFor, removeWorktreeFor } from "../../services/remote-git";
import { WorktreeCreateForm } from "./WorktreeCreateForm";

export interface CanvasWorktreePanelProps {
  cwd: string;
  assignedWorktree: string | null;
  onAssign: (branch: string, path: string) => void;
  onUnassign: () => void;
  onClose: () => void;
  /** When provided, enables "Via Terminal" creation mode. */
  writeToTerminal?: (cmd: string) => void;
  /** When provided, each worktree row shows a "spawn terminal" button. */
  onSpawnTerminal?: (branch: string, path: string) => void;
}

export function CanvasWorktreePanel({
  cwd,
  assignedWorktree,
  onAssign,
  onUnassign,
  onClose,
  writeToTerminal,
  onSpawnTerminal,
}: CanvasWorktreePanelProps) {
  const [entries, setEntries] = useState<WorktreeEntry[] | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setEntries(null);
    setGitError(null);
    // Read at call time rather than captured: the board this panel sits on belongs to one project,
    // and that project's machine is where its repo is.
    listWorktreesFor(getActiveProjectLocation(), cwd)
      .then((result) => { setEntries(result); })
      .catch((err) => {
        setEntries([]);
        const msg: string = err instanceof Error ? err.message : String(err);
        setGitError(msg.includes("git") ? msg : "Not a git repository");
      });
  }, [cwd]);

  useEffect(() => {
    const frame = requestAnimationFrame(load);
    return () => cancelAnimationFrame(frame);
  }, [load]);

  const handleRefresh = useCallback(() => load(), [load]);
  const handleCreated = useCallback(() => {}, []);

  const handleDelete = useCallback(async (worktreePath: string) => {
    try {
      await removeWorktreeFor(getActiveProjectLocation(), cwd, worktreePath);
      load();
    } catch {
      // error surfaced via the row's own state
    }
  }, [cwd, load]);

  const isGitRepo = gitError === null && entries !== null;

  return (
    <div className="canvas-panel canvas-worktree-panel nodrag nopan nowheel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="canvas-panel-header">
        <span className="canvas-panel-title">
          <GitBranch size={11} aria-hidden />
          Worktrees
          {isGitRepo && entries!.length > 0 && (
            <span className="cwp-count">{entries!.length}</span>
          )}
        </span>
        <div className="canvas-panel-header-actions">
          <button className="canvas-panel-icon-btn" aria-label="Refresh worktrees" onClick={handleRefresh} title="Refresh">
            <RefreshCw size={10} />
          </button>
          <button className="canvas-panel-icon-btn" aria-label="Close panel" onClick={onClose}>
            <X size={11} />
          </button>
        </div>
      </div>

      <div className="canvas-panel-body">
        {entries === null && !gitError && (
          <div className="cwp-loading" aria-label="Loading worktrees">
            <span className="cwp-loading-dot" />
            <span className="cwp-loading-dot" />
            <span className="cwp-loading-dot" />
          </div>
        )}

        {gitError && (
          <div className="cwp-no-repo">
            <GitBranch size={18} aria-hidden />
            <p>Not a git repository</p>
            <span>Open a terminal inside a git project to use worktrees.</span>
          </div>
        )}

        {isGitRepo && entries!.length === 0 && !showCreate && (
          <div className="cwp-empty">
            <GitBranch size={20} aria-hidden />
            <p>No worktrees found</p>
            <span>Create one to get started</span>
          </div>
        )}

        {isGitRepo && entries!.length > 0 && (
          <div className="cwp-list">
            {entries!.map((entry) => {
              const isActive = !!entry.branch && entry.branch === assignedWorktree;
              return (
                <WorktreeRow
                  key={entry.path}
                  entry={entry}
                  isActive={isActive}
                  onSelect={() => entry.branch && onAssign(entry.branch, entry.path)}
                  onUnassign={isActive ? onUnassign : undefined}
                  onDelete={entry.isMain || isActive ? undefined : () => handleDelete(entry.path)}
                  onSpawnTerminal={!isActive && entry.branch && onSpawnTerminal ? () => onSpawnTerminal(entry.branch!, entry.path) : undefined}
                />
              );
            })}
          </div>
        )}

        {isGitRepo && (
          <div className="cwp-create-section">
            <button
              className={`cwp-create-toggle${showCreate ? " cwp-create-toggle--open" : ""}`}
              aria-label={showCreate ? "Collapse create form" : "New worktree"}
              onClick={() => setShowCreate((v) => !v)}
            >
              <span className="cwp-create-toggle-icon" aria-hidden>
                {showCreate ? <Minus size={8} /> : <Plus size={8} />}
              </span>
              {showCreate ? "Cancel" : "New worktree"}
            </button>

            {showCreate && (
              <WorktreeCreateForm
                cwd={cwd}
                existingCount={entries?.length ?? 0}
                writeToTerminal={writeToTerminal}
                onCreated={handleCreated}
                onRefresh={handleRefresh}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WorktreeRow({
  entry,
  isActive,
  onSelect,
  onUnassign,
  onDelete,
  onSpawnTerminal,
}: {
  entry: WorktreeEntry;
  isActive: boolean;
  onSelect: () => void;
  onUnassign?: () => void;
  onDelete?: () => void;
  onSpawnTerminal?: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDetached = entry.branch === null;
  const label = entry.branch ?? "Detached HEAD";
  const pathParts = entry.path.replace(/\\/g, "/").split("/");
  const pathLabel = pathParts.slice(-2).join("/");

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete?.();
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);
    }
  }, [confirmDelete, onDelete]);

  const handleCancelDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const handleUnassign = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onUnassign?.();
  }, [onUnassign]);

  const handleSpawnTerminal = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSpawnTerminal?.();
  }, [onSpawnTerminal]);

  const hasActions = !!onUnassign || !!onDelete || !!onSpawnTerminal;

  return (
    <div className={`cwp-row${isActive ? " cwp-row--active" : ""}${isDetached ? " cwp-row--detached" : ""}${confirmDelete ? " cwp-row--confirming" : ""}`}>
      <button
        className="cwp-row-main"
        onClick={onSelect}
        disabled={isDetached || isActive}
        title={isDetached ? "Detached HEAD cannot be assigned" : isActive ? "Currently assigned" : entry.path}
        aria-label={isActive ? `Active worktree ${label}` : `Assign worktree ${label}`}
      >
        <div className="cwp-row-accent" aria-hidden />
        <div className="cwp-row-content">
          <span className="cwp-branch">
            {label}
            {entry.isMain && <span className="cwp-badge cwp-badge--main" aria-label="main worktree">main</span>}
            {isActive && <span className="cwp-badge cwp-badge--active" aria-hidden>assigned</span>}
          </span>
          <span className="cwp-path">{pathLabel}</span>
        </div>
      </button>

      {hasActions && (
        <div className="cwp-row-actions">
          {isActive ? (
            <button
              className="cwp-unassign-btn"
              onClick={handleUnassign}
              aria-label={`Unassign worktree ${label}`}
            >
              Unassign
            </button>
          ) : onSpawnTerminal && !confirmDelete ? (
            <>
              <button
                className="cwp-spawn-btn"
                onClick={handleSpawnTerminal}
                aria-label={`Spawn terminal for worktree ${label}`}
                title="Open in new terminal"
              >
                <SquareTerminal size={9} />
              </button>
              {onDelete && (
                <button
                  className="cwp-delete-btn"
                  onClick={handleDeleteClick}
                  aria-label={`Delete worktree ${label}`}
                  title="Remove worktree"
                >
                  <Trash2 size={9} />
                </button>
              )}
            </>
          ) : confirmDelete ? (
            <>
              <button
                className="cwp-delete-confirm"
                onClick={handleDeleteClick}
                aria-label={`Confirm delete worktree ${label}`}
                title="Click to confirm removal"
              >
                Remove
              </button>
              <button
                className="cwp-delete-cancel"
                onClick={handleCancelDelete}
                aria-label="Cancel delete"
              >
                <X size={9} />
              </button>
            </>
          ) : (
            <button
              className="cwp-delete-btn"
              onClick={handleDeleteClick}
              aria-label={`Delete worktree ${label}`}
              title="Remove worktree"
            >
              <Trash2 size={9} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
