"use client";

import { AlertTriangle, ArrowDown, ArrowUp, CircleX, GitBranch, Loader2 } from "lucide-react";
import type { CodespaceGitRepoSummary } from "@/lib/tauri-api";
import { editorLanguageLabel } from "@/modules/codespace/services/editor-languages";
import { formatIndent, type EditorStatus } from "@/modules/codespace/services/editor-status";
import type { LspFileStatus } from "@/modules/codespace/services/lsp/lsp-manager";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

interface WorkbenchStatusBarProps {
  dirty: boolean;
  /** Cursor and indentation; `null` while no text file is in the editor. */
  status: EditorStatus | null;
  git: CodespaceGitRepoSummary | null;
  /** Who last changed the cursor line ("You · 2h ago"); absent when blame is off or unknown. */
  blame?: string | null;
  language: string | null;
  /** The open file's encoding (`editor_encoding.rs` id); absent means UTF-8. */
  encoding?: string | null;
  /** A save conflict or git error, shown at the left in amber. */
  notice?: string | null;
  /** A git action running now ("Committing…"), with a spinner. */
  activity?: string | null;
  /** The open file's language server; `null` for a language without one. */
  languageServer?: LspFileStatus | null;
  /** Errors and warnings the workspace's language servers report; `null` while none runs. */
  problems?: { errors: number; warnings: number } | null;
  onLanguageServerClick?: () => void;
  /** Goes to the next problem in the open file. */
  onProblemsClick?: () => void;
  /** Opens the blamed line's commit in the Git graph's commit tab. */
  onBlameClick?: () => void;
  /** Switches the file between LF and CRLF line endings. */
  onEndOfLineClick?: () => void;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const ENCODING_LABELS: Record<string, string> = {
  utf8: "UTF-8",
  utf8bom: "UTF-8 with BOM",
  utf16le: "UTF-16 LE",
  utf16be: "UTF-16 BE",
  windows1252: "Windows 1252",
};

export function encodingLabel(encoding: string | null | undefined): string {
  return ENCODING_LABELS[encoding ?? "utf8"] ?? encoding ?? "UTF-8";
}

/** What the language server item says, and what its tooltip adds. */
export function languageServerText(status: LspFileStatus): { text: string; title: string } {
  switch (status.kind) {
    case "off":
      return { text: `${status.label} off`, title: "Language servers are turned off in Settings." };
    case "untrusted":
      return { text: `${status.label} off`, title: "This folder is not trusted, so no language server runs here. Click to decide." };
    case "missing":
      return { text: `No ${status.label}`, title: `${status.label} is not installed. Install it with: ${status.installHint} (click to copy)` };
    case "starting":
      return { text: status.label, title: `${status.label} is starting` };
    case "ready":
      return { text: status.progress ? `${status.label}: ${status.progress}` : status.label, title: `${status.label} is running` };
    case "error":
      return { text: `${status.label} stopped`, title: `${status.message} (click to restart)` };
  }
}

/**
 * Only what is known: problems only while a language server reports them.
 *
 * The bar is a plain labelled group, not a live region: as one big `role="status"` a screen
 * reader read the whole bar again on every cursor move and keystroke. Only the notice and the
 * running git action are spoken, from a live region that is always mounted (one inserted with
 * its text already in it is not announced).
 */
export function WorkbenchStatusBar({
  dirty,
  status,
  git,
  blame = null,
  language,
  encoding = null,
  notice = null,
  activity = null,
  languageServer = null,
  problems = null,
  onLanguageServerClick,
  onProblemsClick,
  onBlameClick,
  onEndOfLineClick,
}: WorkbenchStatusBarProps) {
  const shortcut = useFormatShortcut();
  return (
    <div role="group" aria-label="Editor status" className="codespace-workbench-statusbar">
      {dirty ? <span className="codespace-workbench-statusbar-unsaved">Unsaved · {shortcut("⌘S")}</span> : null}
      {git?.branch ? (
        <span className="flex min-w-0 items-center gap-1" title={git.upstream ? `${git.branch} → ${git.upstream}` : git.branch}>
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{git.branch}</span>
          {git.ahead > 0 ? (
            <span className="codespace-workbench-statusbar-quiet flex items-center" aria-label={`${plural(git.ahead, "commit")} to push`}>
              <ArrowUp className="h-3 w-3" aria-hidden="true" />{git.ahead}
            </span>
          ) : null}
          {git.behind > 0 ? (
            <span className="codespace-workbench-statusbar-quiet flex items-center" aria-label={`${plural(git.behind, "commit")} to pull`}>
              <ArrowDown className="h-3 w-3" aria-hidden="true" />{git.behind}
            </span>
          ) : null}
        </span>
      ) : null}
      {blame && onBlameClick ? (
        <button
          type="button"
          className="codespace-workbench-statusbar-button codespace-workbench-statusbar-quiet min-w-0 truncate"
          title="Last change to this line. Click to open its commit."
          onClick={onBlameClick}
        >
          {blame}
        </button>
      ) : blame ? (
        <span className="codespace-workbench-statusbar-quiet min-w-0 truncate" title="Last change to this line">{blame}</span>
      ) : null}
      <span role="status" className="flex min-w-0 items-center gap-3">
        {activity ? (
          <span className="flex shrink-0 items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            {activity}
          </span>
        ) : null}
        {notice ? <span className="min-w-0 truncate text-amber-200/80">{notice}</span> : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {status ? <span>Ln {status.line}, Col {status.column}</span> : null}
        {status ? <span>{formatIndent(status)}</span> : null}
        {status ? <span>{encodingLabel(encoding)}</span> : null}
        {status ? (
          <button
            type="button"
            className="codespace-workbench-statusbar-button"
            aria-label={`Line endings ${status.eol}. Change to ${status.eol === "LF" ? "CRLF" : "LF"}`}
            title={`Line endings: ${status.eol === "LF" ? "LF (macOS, Linux)" : "CRLF (Windows)"}. Click to change to ${status.eol === "LF" ? "CRLF" : "LF"}.`}
            onClick={onEndOfLineClick}
          >
            {status.eol}
          </button>
        ) : null}
        {problems ? (
          <button
            type="button"
            className="codespace-workbench-statusbar-button"
            aria-label={`${plural(problems.errors, "error")}, ${plural(problems.warnings, "warning")}`}
            title="Go to the next problem (F8)"
            onClick={onProblemsClick}
          >
            <CircleX className="h-3 w-3" aria-hidden="true" />{problems.errors}
            <AlertTriangle className="ml-1.5 h-3 w-3" aria-hidden="true" />{problems.warnings}
          </button>
        ) : null}
        {language ? <span>{editorLanguageLabel(language)}</span> : null}
        {languageServer ? <LanguageServerItem status={languageServer} onClick={onLanguageServerClick} /> : null}
      </span>
    </div>
  );
}

function LanguageServerItem({ status, onClick }: { status: LspFileStatus; onClick?: () => void }) {
  const { text, title } = languageServerText(status);
  const busy = status.kind === "starting" || (status.kind === "ready" && Boolean(status.progress));
  const quiet = status.kind === "off" || status.kind === "untrusted" || status.kind === "missing";
  return (
    <button
      type="button"
      className={`codespace-workbench-statusbar-button${quiet ? " codespace-workbench-statusbar-quiet" : ""}${status.kind === "error" ? " text-amber-200/80" : ""}`}
      title={title}
      aria-label={`${text}. ${title}`}
      onClick={onClick}
    >
      {busy ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" /> : null}
      <span className="max-w-[16rem] truncate">{text}</span>
    </button>
  );
}
