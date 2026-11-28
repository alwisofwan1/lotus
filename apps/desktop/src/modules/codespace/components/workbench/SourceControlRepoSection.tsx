"use client";

import Image from "next/image";
import { createPortal } from "react-dom";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowUpFromLine, ChevronRight, GitCommitHorizontal, Loader2, Minus, Plus, RefreshCw, Sparkles, Trash2, Undo2, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CodespaceGitFileStatus, CodespaceGitRepoSummary } from "@/lib/tauri-api";
import { resolveWorkbenchFileIcon } from "@/modules/codespace/services/file-icon-theme";
import {
  CONVENTIONAL_COMMIT_TYPES,
  applyConventionalType,
  extractCommitType,
  suggestConventionalCommitHeuristic,
  type ConventionalCommitType,
} from "@/modules/codespace/services/conventional-commit";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

/*
 * One repository in Source.
 *
 * The header is two quiet lines, name over branch, so neither has to be cut to fit the other in a
 * narrow sidebar. Everything below it appears only when it has something to act on: the commit box
 * when there are changes, Push when there is something to push. Actions that cannot run are not
 * drawn greyed out, they are not drawn.
 */

export interface SourceControlRepoSectionProps {
  rootDir: string;
  statuses: CodespaceGitFileStatus[];
  summary: CodespaceGitRepoSummary | null;
  available: boolean;
  loading: boolean;
  /** Something runs in this repo: every action waits, the one running shows a spinner. */
  busy?: boolean;
  actionPath: string | null;
  commitMessage: string;
  committing: boolean;
  pushing: boolean;
  aiSuggesting: boolean;
  error: string | null;
  defaultExpanded?: boolean;
  onCommitMessageChange: (message: string) => void;
  onCommit: () => void;
  onPush: () => void;
  onAiSuggestCommit: () => void;
  onRefresh: () => void;
  onStageFile: (filePath: string) => void;
  onUnstageFile: (filePath: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardAllChanges: () => void;
  /** Called after the user confirmed. Without it, rows have no Discard button. */
  onDiscardFile?: (filePath: string) => void;
  onViewDiff: (filePath: string, target: "staged" | "unstaged") => void;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

function statusCode(status: CodespaceGitFileStatus, target: "staged" | "unstaged"): string {
  const change = target === "staged" ? status.staged : status.unstaged;
  if (change === "untracked") return "U";
  if (change === "added") return "A";
  if (change === "deleted") return "D";
  if (change === "renamed") return "R";
  if (change === "copied") return "C";
  if (change === "unmerged") return "!";
  return "M";
}

/** The question before a file's changes are thrown away; an untracked file is deleted outright. */
export function discardFileQuestion(status: CodespaceGitFileStatus): string {
  // The path from the repo root, not the bare name: two files can share one.
  const name = status.relativePath;
  return status.unstaged === "untracked"
    ? `Delete ${name}?\n\nGit does not track it, so it cannot be brought back.`
    : `Discard changes in ${name}?\n\nThis cannot be undone.`;
}

type StatusTone = "added" | "deleted" | "staged" | "modified";

function statusTone(status: CodespaceGitFileStatus, target: "staged" | "unstaged"): StatusTone {
  const change = target === "staged" ? status.staged : status.unstaged;
  if (change === "untracked" || change === "added") return "added";
  if (change === "deleted" || change === "unmerged") return "deleted";
  return target === "staged" ? "staged" : "modified";
}

function groupStatuses(statuses: CodespaceGitFileStatus[]) {
  return {
    staged: statuses.filter((s) => Boolean(s.staged)),
    unstaged: statuses.filter((s) => Boolean(s.unstaged)),
  };
}

/** `↑2 ↓5`: arrows, not signs. "-240" read as a count that had gone negative. */
export function formatAheadBehind(summary: CodespaceGitRepoSummary | null): string | null {
  if (!summary?.upstream) return null;
  const parts: string[] = [];
  if (summary.ahead > 0) parts.push(`↑${summary.ahead}`);
  if (summary.behind > 0) parts.push(`↓${summary.behind}`);
  return parts.length ? parts.join(" ") : null;
}

function aheadBehindTitle(summary: CodespaceGitRepoSummary): string {
  const parts: string[] = [];
  if (summary.ahead > 0) parts.push(`${summary.ahead} to push`);
  if (summary.behind > 0) parts.push(`${summary.behind} to pull`);
  return `${parts.join(", ")} (${summary.upstream})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getBranchPopoverStyle(anchor: HTMLElement, branch: string): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const margin = 12;
  const gap = 10;
  const minWidth = 220;
  const preferredWidth = clamp(140 + branch.length * 5.2, 240, 360);
  const rightSpace = window.innerWidth - rect.right - margin - gap;
  const leftSpace = rect.left - margin - gap;
  const estimatedHeight = branch.length > 48 ? 74 : 58;

  if (rightSpace >= minWidth || rightSpace >= leftSpace) {
    const width = Math.max(minWidth, Math.min(preferredWidth, window.innerWidth - rect.right - margin - gap));
    return {
      left: rect.right + gap,
      top: clamp(rect.top - 14, margin, window.innerHeight - estimatedHeight - margin),
      width,
    };
  }

  if (leftSpace >= minWidth) {
    const width = Math.max(minWidth, Math.min(preferredWidth, leftSpace));
    return {
      left: rect.left - gap - width,
      top: clamp(rect.top - 14, margin, window.innerHeight - estimatedHeight - margin),
      width,
    };
  }

  const width = Math.max(180, window.innerWidth - margin * 2);
  return {
    left: margin,
    top: clamp(rect.bottom + gap, margin, window.innerHeight - estimatedHeight - margin),
    width,
  };
}

function IconAction({
  label,
  tone,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tone?: "danger";
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn("scm-icon-action", tone === "danger" && "scm-icon-action--danger")}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function ChangeRow({
  status, target, busy, running, onViewDiff, onStageFile, onUnstageFile, onDiscardFile,
}: {
  status: CodespaceGitFileStatus;
  target: "staged" | "unstaged";
  /** The repo is busy: nothing here can start. */
  busy: boolean;
  /** This row's own action is the one running. */
  running: boolean;
  onViewDiff: (fp: string, t: "staged" | "unstaged") => void;
  onStageFile: (fp: string) => void;
  onUnstageFile: (fp: string) => void;
  onDiscardFile?: (status: CodespaceGitFileStatus) => void;
}) {
  const fileIcon = resolveWorkbenchFileIcon(status.path);
  const name = basename(status.relativePath);
  return (
    <div className="scm-change-row group">
      <button
        type="button"
        className="scm-change-open"
        onClick={() => onViewDiff(status.path, target)}
        title={status.relativePath}
      >
        <Image src={fileIcon.src} alt="" aria-hidden="true" width={14} height={14} unoptimized className="codespace-workbench-file-icon" draggable={false} />
        <span className="min-w-0 truncate">{name}</span>
      </button>
      <span className="scm-change-actions">
        {target === "unstaged" && onDiscardFile ? (
          <IconAction label={`Discard ${name}`} tone="danger" disabled={busy} onClick={() => onDiscardFile(status)}>
            <Undo2 className="h-3 w-3" />
          </IconAction>
        ) : null}
        {target === "unstaged" ? (
          <IconAction label={`Stage ${name}`} disabled={busy} onClick={() => onStageFile(status.path)}>
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          </IconAction>
        ) : (
          <IconAction label={`Unstage ${name}`} disabled={busy} onClick={() => onUnstageFile(status.path)}>
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Minus className="h-3 w-3" />}
          </IconAction>
        )}
      </span>
      <button
        type="button"
        className={cn("scm-status", `scm-status--${statusTone(status, target)}`)}
        onClick={() => onViewDiff(status.path, target)}
        title={`View ${target} diff`}
      >
        {statusCode(status, target)}
      </button>
    </div>
  );
}

function ChangeGroup({ title, target, statuses, actionPath, busy, loading, onViewDiff, onStageFile, onUnstageFile, onStageAll, onUnstageAll, onDiscardAllChanges, onDiscardFile }: { title: string; target: "staged" | "unstaged"; statuses: CodespaceGitFileStatus[]; actionPath: string | null; busy: boolean; loading: boolean; onViewDiff: (fp: string, t: "staged" | "unstaged") => void; onStageFile: (fp: string) => void; onUnstageFile: (fp: string) => void; onStageAll: () => void; onUnstageAll: () => void; onDiscardAllChanges: () => void; onDiscardFile?: (status: CodespaceGitFileStatus) => void }) {
  if (statuses.length === 0) return null;
  const bulkDisabled = loading || busy || actionPath === "__all__";
  return (
    <section className="scm-group group/group" aria-label={title}>
      <div className="scm-group-header">
        <span className="scm-group-title">{title}</span>
        <span className="scm-group-count">{statuses.length}</span>
        <span className="scm-group-actions">
          {target === "staged" ? (
            <IconAction label="Unstage all changes" disabled={bulkDisabled} onClick={onUnstageAll}><Minus className="h-3 w-3" /></IconAction>
          ) : (
            <>
              <IconAction label="Discard all changes" tone="danger" disabled={bulkDisabled} onClick={onDiscardAllChanges}><Trash2 className="h-3 w-3" /></IconAction>
              <IconAction label="Stage all changes" disabled={bulkDisabled} onClick={onStageAll}><Plus className="h-3 w-3" /></IconAction>
            </>
          )}
        </span>
      </div>
      {statuses.map((s) => (
        <ChangeRow key={`${target}:${s.path}`} status={s} target={target} busy={busy} running={actionPath === s.path} onViewDiff={onViewDiff} onStageFile={onStageFile} onUnstageFile={onUnstageFile} onDiscardFile={onDiscardFile} />
      ))}
    </section>
  );
}

export function SourceControlRepoSection({
  rootDir, statuses, summary, available, loading, busy = false, actionPath,
  commitMessage, committing, pushing, aiSuggesting, error, defaultExpanded = true,
  onCommitMessageChange, onCommit, onPush, onAiSuggestCommit, onRefresh,
  onStageFile, onUnstageFile, onStageAll, onUnstageAll, onDiscardAllChanges, onDiscardFile, onViewDiff,
}: SourceControlRepoSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const shortcut = useFormatShortcut();
  const [branchPopover, setBranchPopover] = useState<{ branch: string; style: CSSProperties } | null>(null);
  const { staged, unstaged } = groupStatuses(statuses);
  const canCommit = staged.length > 0 && commitMessage.trim().length > 0 && !busy && !committing;
  const aheadBehind = formatAheadBehind(summary);
  const activeType = extractCommitType(commitMessage);
  const commitInputRef = useRef<HTMLTextAreaElement>(null);
  const heuristicSuggestion = staged.length > 0 ? suggestConventionalCommitHeuristic({ rootDir, statuses: staged }) : null;
  const canSuggest = staged.length > 0 && !busy && !committing && !aiSuggesting;
  const hasUpstream = Boolean(summary?.upstream);
  const aheadCount = summary?.ahead ?? 0;
  // Shown only when there is something to push (or a branch to publish); never as a dead button.
  const pushOffered = available && Boolean(summary) && (!hasUpstream || aheadCount > 0);
  const canPush = pushOffered && !busy && !pushing && !committing && !loading;
  const pushLabel = pushing ? "Pushing" : hasUpstream ? `Push (${aheadCount})` : "Publish";
  const commitTitle = staged.length === 0
    ? "Stage changes to commit them"
    : commitMessage.trim() ? `Commit to ${summary?.branch ?? "this branch"} (${shortcut("⌘Enter")})` : "Write a message first";

  const handleSelectType = (type: ConventionalCommitType) => onCommitMessageChange(applyConventionalType(commitMessage, type));
  const showBranchPopover = useCallback((target: HTMLElement, branch: string) => {
    // Only when the name is cut: a branch that fits needs no second copy of itself.
    if (target.scrollWidth <= target.clientWidth) return;
    setBranchPopover({ branch, style: getBranchPopoverStyle(target, branch) });
  }, []);
  const hideBranchPopover = useCallback(() => setBranchPopover(null), []);
  const handleHeuristicFill = () => {
    if (!heuristicSuggestion) return;
    onCommitMessageChange(commitMessage.trim().length === 0 ? heuristicSuggestion.template : applyConventionalType(commitMessage, heuristicSuggestion.type));
  };

  const handleDiscardAllChanges = useCallback(() => {
    if (!window.confirm("Discard all working tree changes?\n\nThis cannot be undone.")) return;
    onDiscardAllChanges();
  }, [onDiscardAllChanges]);

  const handleDiscardFile = useMemo(() => {
    if (!onDiscardFile) return undefined;
    return (status: CodespaceGitFileStatus) => {
      if (!window.confirm(discardFileQuestion(status))) return;
      onDiscardFile(status.path);
    };
  }, [onDiscardFile]);

  useLayoutEffect(() => {
    const textarea = commitInputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const h = Math.min(Math.max(textarea.scrollHeight, 30), 120);
    textarea.style.height = `${h}px`;
    textarea.style.overflowY = textarea.scrollHeight > 120 ? "auto" : "hidden";
  }, [commitMessage, expanded]);

  const name = basename(rootDir);

  return (
    <div className={cn("scm-repo", expanded && "scm-repo--open")}>
      <div className="scm-repo-header group/header">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="scm-repo-toggle"
          aria-label="Toggle repo section"
          aria-expanded={expanded}
          title={rootDir}
        >
          <ChevronRight className="scm-repo-chevron" aria-hidden="true" />
          <span className="scm-repo-lines">
            <span className="scm-repo-name">{name}</span>
            {summary ? (
              <span
                className="scm-repo-branch"
                aria-label={`Branch ${summary.branch}`}
                onPointerEnter={(event) => showBranchPopover(event.currentTarget, summary.branch)}
                onPointerLeave={hideBranchPopover}
                onMouseEnter={(event) => showBranchPopover(event.currentTarget, summary.branch)}
                onMouseLeave={hideBranchPopover}
              >
                {summary.branch}
              </span>
            ) : null}
          </span>
        </button>
        <span className="scm-repo-meta">
          {aheadBehind && summary ? <span className="scm-repo-sync" title={aheadBehindTitle(summary)}>{aheadBehind}</span> : null}
          {statuses.length > 0 ? (
            <span className="scm-repo-count" title={`${statuses.length} change${statuses.length === 1 ? "" : "s"}`}>{statuses.length}</span>
          ) : null}
          <button type="button" className={cn("scm-icon-action scm-repo-refresh", loading && "is-loading")} onClick={onRefresh} aria-label="Refresh source control" title="Refresh">
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </button>
        </span>
      </div>

      {branchPopover && typeof document !== "undefined" ? createPortal(
        <div className="source-repo-branch-popover" role="tooltip" style={branchPopover.style}>
          <span className="source-repo-branch-popover-kicker">Branch</span>
          <span className="source-repo-branch-popover-name">{branchPopover.branch}</span>
        </div>,
        document.body,
      ) : null}

      {expanded && (
        <div className="scm-repo-body">
          {!available ? (
            <p className="scm-note">No repository detected</p>
          ) : (
            <>
              {statuses.length > 0 ? (
                <div className="scm-composer group/composer">
                  <div className="scm-message">
                    <textarea
                      ref={commitInputRef}
                      className="scm-message-input"
                      placeholder="Commit message"
                      aria-label={`Commit message for ${summary?.branch ?? name}`}
                      value={commitMessage}
                      onChange={(e) => onCommitMessageChange(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                          e.preventDefault();
                          if (canCommit) onCommit();
                        }
                      }}
                    />
                    <span className="scm-message-tools">
                      <IconAction label="Quick template" disabled={!canSuggest || !heuristicSuggestion} onClick={handleHeuristicFill}>
                        <Wand2 className="h-3 w-3" />
                      </IconAction>
                      <button
                        type="button"
                        onClick={onAiSuggestCommit}
                        disabled={!canSuggest}
                        className="scm-icon-action scm-icon-action--ai"
                        aria-label="AI-generated commit message"
                        title="Write the message with AI"
                        aria-busy={aiSuggesting}
                      >
                        {aiSuggesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                      </button>
                    </span>
                  </div>
                  {/* Only while writing: the types are a writing aid, not something to look at. */}
                  <div className="scm-types" role="group" aria-label="Commit type">
                    {CONVENTIONAL_COMMIT_TYPES.map(({ type, description }) => (
                      <button
                        key={type}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => handleSelectType(type)}
                        title={`${type}: ${description}`}
                        className={cn("scm-type", activeType === type && "is-active")}
                        aria-pressed={activeType === type}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                  <div className="scm-commit-row">
                    <button
                      type="button"
                      onClick={onCommit}
                      disabled={!canCommit}
                      className="scm-commit"
                      aria-label={committing ? "Committing" : "Commit"}
                      aria-busy={committing}
                      title={commitTitle}
                    >
                      {committing ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitCommitHorizontal className="h-3 w-3" />}
                      <span className="truncate">{committing ? "Committing" : "Commit"}</span>
                      {staged.length > 0 && !committing ? <span className="scm-commit-count">{staged.length}</span> : null}
                    </button>
                    {pushOffered ? (
                      <button type="button" onClick={onPush} disabled={!canPush} aria-busy={pushing} className="scm-push" title={hasUpstream ? `Push to ${summary?.upstream}` : "Publish this branch"}>
                        {pushing ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpFromLine className="h-3 w-3" />}
                        <span className="truncate">{pushLabel}</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : pushOffered ? (
                <div className="scm-commit-row scm-commit-row--solo">
                  <button type="button" onClick={onPush} disabled={!canPush} aria-busy={pushing} className="scm-push scm-push--wide" title={hasUpstream ? `Push to ${summary?.upstream}` : "Publish this branch"}>
                    {pushing ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpFromLine className="h-3 w-3" />}
                    <span className="truncate">{pushLabel}</span>
                  </button>
                </div>
              ) : null}

              {statuses.length === 0 ? (
                <p className="scm-note">Working tree clean</p>
              ) : (
                <>
                  <ChangeGroup title="Staged" target="staged" statuses={staged} actionPath={actionPath} busy={busy} loading={loading} onViewDiff={onViewDiff} onStageFile={onStageFile} onUnstageFile={onUnstageFile} onStageAll={onStageAll} onUnstageAll={onUnstageAll} onDiscardAllChanges={handleDiscardAllChanges} />
                  <ChangeGroup title="Changes" target="unstaged" statuses={unstaged} actionPath={actionPath} busy={busy} loading={loading} onViewDiff={onViewDiff} onStageFile={onStageFile} onUnstageFile={onUnstageFile} onStageAll={onStageAll} onUnstageAll={onUnstageAll} onDiscardAllChanges={handleDiscardAllChanges} onDiscardFile={handleDiscardFile} />
                </>
              )}
            </>
          )}
          {error && <p className="scm-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
