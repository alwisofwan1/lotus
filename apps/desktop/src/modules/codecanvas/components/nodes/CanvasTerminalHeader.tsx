"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Globe } from "lucide-react";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import type { TerminalActivity } from "@/modules/codespace/services/terminal-activity-registry";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import {
  normalizeTerminalLabel,
  TERMINAL_LABEL_MAX_LENGTH,
  terminalDisplayName,
} from "../../services/terminal/terminal-node-identity";

export interface CanvasTerminalHeaderProps {
  terminalNumber: number;
  label?: string;
  runtimeStatus: TerminalRuntimeStatus;
  /** Work axis (docs/adr/0004); shown in place of `live` while connected. */
  activity: TerminalActivity;
  currentCwd: string;
  assignedWorktree: string | null;
  worktreeActive?: boolean;
  skillsActive?: boolean;
  browserActive?: boolean;
  onKill: () => void;
  onToggleWT: () => void;
  onToggleSK: () => void;
  onToggleBrowser?: () => void;
  onFocus?: () => void;
  onRename?: (label: string) => void;
}

/**
 * Ultra-minimal single-row terminal header (ADR-0033), mirroring the live-agent persona
 * header: a status dot, a prompt glyph, the name, and the cwd/worktree inline — then the
 * action bar. No icon chip, no status word, no second path row, and no top accent strip:
 * liveness rides the dot, and the cwd is muted context that truncates before the actions.
 */
export const CanvasTerminalHeader = memo(function CanvasTerminalHeader({
  terminalNumber,
  label,
  runtimeStatus,
  activity,
  currentCwd,
  assignedWorktree,
  worktreeActive = false,
  skillsActive = false,
  browserActive = false,
  onKill,
  onToggleSK,
  onToggleWT,
  onToggleBrowser,
  onFocus,
  onRename,
}: CanvasTerminalHeaderProps) {
  const displayName = terminalDisplayName({ label, terminalNumber });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const [renameError, setRenameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const beginRename = useCallback(() => {
    if (!onRename) return;
    setDraft(displayName);
    setRenameError(null);
    setEditing(true);
  }, [displayName, onRename]);

  const cancelRename = useCallback(() => {
    setEditing(false);
    setRenameError(null);
  }, []);

  const commitRename = useCallback(() => {
    const next = normalizeTerminalLabel(draft);
    if (!next) {
      setRenameError("Enter a terminal name");
      inputRef.current?.focus();
      return;
    }
    if (next !== displayName) onRename?.(next);
    setEditing(false);
    setRenameError(null);
  }, [displayName, draft, onRename]);

  const isLive = runtimeStatus === "live";
  const isRunning = isLive && activity === "running";

  // Dot follows Terminal Activity while connected: muted gray at rest, green only while running.
  const dotKey = isRunning ? "running" : isLive ? "idle" : runtimeStatus;

  const cwdLabel = currentCwd.split("/").filter(Boolean).pop() ?? currentCwd;

  return (
    <div className="cth-root">
      <div className="cth-row1">
        <div className="cth-identity">
          <span className={`cth-dot cth-dot--${dotKey}`} aria-hidden />
          <span className="cth-glyph" aria-hidden>❯</span>
          {editing ? (
            <input
              ref={inputRef}
              className="cth-name-input nodrag"
              aria-label="Terminal name"
              aria-invalid={renameError ? true : undefined}
              title={renameError ?? undefined}
              value={draft}
              maxLength={TERMINAL_LABEL_MAX_LENGTH}
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value);
                setRenameError(null);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              onBlur={commitRename}
            />
          ) : (
            <span
              className="cth-name"
              title={onRename ? "Right-click to rename" : displayName}
              onContextMenu={onRename ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                beginRename();
              } : undefined}
            >
              {displayName}
            </span>
          )}
          <span className="cth-sep" aria-hidden>·</span>
          {assignedWorktree ? (
            <span className="cth-loc cth-loc--worktree" title={assignedWorktree}>
              <GitBranch size={9} aria-hidden />
              {assignedWorktree}
            </span>
          ) : (
            <span className="cth-loc" title={currentCwd}>{cwdLabel}</span>
          )}
        </div>

        <div className="cth-actions" data-drag-handle="false">
          <button
            className={`cth-action${worktreeActive ? " cth-action--active" : ""}`}
            aria-label="Worktree"
            aria-pressed={worktreeActive}
            onClick={(e) => { e.stopPropagation(); onToggleWT(); }}
          >
            WT
          </button>
          <button
            className={`cth-action${skillsActive ? " cth-action--active" : ""}`}
            aria-label="Skill"
            aria-pressed={skillsActive}
            onClick={(e) => { e.stopPropagation(); onToggleSK(); }}
          >
            SK
          </button>
          <button
            className={`cth-action${browserActive ? " cth-action--active" : ""}`}
            aria-label="Open browser preview"
            aria-pressed={browserActive}
            onClick={(e) => { e.stopPropagation(); onToggleBrowser?.(); }}
          >
            <Globe size={11} />
          </button>
          <span className="cth-actions-sep" aria-hidden />
          {onFocus && <CanvasNodeFocusAction onFocus={onFocus} className="cth-action cth-action--focus" />}
          <button
            className="cth-action cth-action--kill"
            aria-label="Kill terminal"
            onClick={(e) => { e.stopPropagation(); onKill(); }}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
});
