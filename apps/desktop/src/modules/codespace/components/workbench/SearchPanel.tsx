"use client";

import { ChevronRight, Ellipsis, Loader2, RefreshCw, Search, ChevronsDownUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  editorSearchCancel,
  editorSearchFor,
  type CodeSpaceStoredWorkspaceLocation,
  type EditorSearchFile,
  type EditorSearchMatch,
  type EditorSearchQuery,
  type EditorSearchResult,
} from "@/lib/tauri/codespace";
import { formatRemoteError, parseRemoteError } from "@/lib/tauri/remote-error";
import { cn } from "@/lib/utils";

/** Typing waits this long before a search starts; Enter starts it at once. */
export const SEARCH_DEBOUNCE_MS = 300;

interface SearchPanelProps {
  /** Names this pane's search, so a newer one can stop it. */
  searchId: string;
  rootDir: string;
  location?: CodeSpaceStoredWorkspaceLocation | null;
  onOpenMatch: (path: string, match: EditorSearchMatch) => void;
  /** A new value focuses the query box and selects it (⌘⇧F). `seed` fills it first. */
  focusRequest?: { nonce: number; seed?: string } | null;
}

type Toggles = Pick<EditorSearchQuery, "caseSensitive" | "wholeWord" | "isRegex">;

type SearchState =
  | { kind: "idle" }
  | { kind: "running"; previous: EditorSearchResult | null }
  | { kind: "done"; result: EditorSearchResult }
  | { kind: "error"; message: string };

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

function relativeTo(rootDir: string, path: string): string {
  const root = rootDir.replace(/\/+$/, "");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function splitPath(relative: string): { name: string; folder: string } {
  const slash = relative.lastIndexOf("/");
  return slash < 0 ? { name: relative, folder: "" } : { name: relative.slice(slash + 1), folder: relative.slice(0, slash) };
}

/** Find in files: VS Code's search view, for one workspace folder, local or over SSH. */
export function SearchPanel({ searchId, rootDir, location = null, onOpenMatch, focusRequest = null }: SearchPanelProps) {
  const [pattern, setPattern] = useState("");
  const [toggles, setToggles] = useState<Toggles>({ caseSensitive: false, wholeWord: false, isRegex: false });
  const [showFilters, setShowFilters] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Only the newest search may write its answer.
  const sequenceRef = useRef(0);

  const query = useMemo<EditorSearchQuery>(() => ({
    pattern,
    ...toggles,
    ...(include.trim() ? { include: include.trim() } : {}),
    ...(exclude.trim() ? { exclude: exclude.trim() } : {}),
  }), [exclude, include, pattern, toggles]);

  const run = useCallback((next: EditorSearchQuery) => {
    sequenceRef.current += 1;
    const sequence = sequenceRef.current;
    void editorSearchCancel(searchId).catch(() => {});
    if (!next.pattern) {
      setState({ kind: "idle" });
      return;
    }
    setState((current) => ({
      kind: "running",
      previous: current.kind === "done" ? current.result : current.kind === "running" ? current.previous : null,
    }));
    editorSearchFor(location, rootDir, next, searchId)
      .then((result) => {
        if (sequence !== sequenceRef.current) return;
        setState({ kind: "done", result });
        setCollapsed(new Set());
      })
      .catch((error: unknown) => {
        if (sequence !== sequenceRef.current) return;
        setState({ kind: "error", message: formatRemoteError(parseRemoteError(error)) });
      });
  }, [location, rootDir, searchId]);

  // Typing searches by itself after a pause; one character waits for Enter (it matches nearly
  // every line of every file).
  useEffect(() => {
    if (query.pattern.length < 2) {
      if (!query.pattern) run(query);
      return;
    }
    const timer = window.setTimeout(() => run(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, run]);

  // Leaving the pane stops whatever is still walking the disk.
  useEffect(() => () => {
    sequenceRef.current += 1;
    void editorSearchCancel(searchId).catch(() => {});
  }, [searchId]);

  const focusNonce = focusRequest?.nonce;
  useEffect(() => {
    if (focusNonce === undefined) return;
    if (focusRequest?.seed) setPattern(focusRequest.seed);
    const input = inputRef.current;
    input?.focus();
    input?.select();
    // The nonce names the request; the seed comes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  const result = state.kind === "done" ? state.result : state.kind === "running" ? state.previous : null;
  const toggle = (key: keyof Toggles) => setToggles((current) => ({ ...current, [key]: !current[key] }));

  const summary = state.kind === "error"
    ? null
    : state.kind === "running" && !state.previous
      ? "Searching…"
      : !result
        ? null
        : result.matchCount === 0
          ? "No results"
          : `${plural(result.matchCount, "result")} in ${plural(result.files.length, "file")}`;

  const toggleFile = (path: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  return (
    <div className="codespace-search" role="search" aria-label="Search in files">
      <div className="codespace-search-form">
        <div className="codespace-filetree-search codespace-search-box">
          <Search className="h-3 w-3 shrink-0 text-[color:var(--codespace-panel-text-quiet)]" aria-hidden="true" />
          <input
            ref={inputRef}
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[color:var(--codespace-panel-text-quiet)]"
            placeholder="Search"
            value={pattern}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setPattern(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                run(query);
              } else if (event.key === "Escape" && pattern) {
                event.preventDefault();
                event.stopPropagation();
                setPattern("");
              }
            }}
          />
          <SearchToggle label="Match case" text="Aa" pressed={Boolean(toggles.caseSensitive)} onClick={() => toggle("caseSensitive")} />
          <SearchToggle label="Match whole word" text="ab" underline pressed={Boolean(toggles.wholeWord)} onClick={() => toggle("wholeWord")} />
          <SearchToggle label="Use regular expression" text=".*" pressed={Boolean(toggles.isRegex)} onClick={() => toggle("isRegex")} />
        </div>
        <div className="codespace-search-tools">
          <button
            type="button"
            className={cn("scm-icon-action", showFilters && "is-active")}
            aria-label="Files to include or exclude"
            aria-expanded={showFilters}
            title="Files to include or exclude"
            onClick={() => setShowFilters((value) => !value)}
          >
            <Ellipsis className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="scm-icon-action"
            aria-label="Search again"
            title="Search again"
            disabled={!pattern}
            onClick={() => run(query)}
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="scm-icon-action"
            aria-label="Collapse all"
            title="Collapse all"
            disabled={!result?.files.length}
            onClick={() => setCollapsed(new Set(result?.files.map((file) => file.path)))}
          >
            <ChevronsDownUp className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
        {showFilters ? (
          <div className="codespace-search-filters">
            <input
              aria-label="Files to include"
              className="codespace-filetree-search codespace-search-filter"
              placeholder="Files to include (src/**, *.ts)"
              value={include}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setInclude(event.target.value)}
            />
            <input
              aria-label="Files to exclude"
              className="codespace-filetree-search codespace-search-filter"
              placeholder="Files to exclude (dist, *.min.js)"
              value={exclude}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setExclude(event.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div role="status" className="codespace-search-summary">
        {state.kind === "running" ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" /> : null}
        {state.kind === "error" ? <span className="codespace-search-error">{state.message}</span> : summary}
        {result?.truncated ? (
          <span className="codespace-search-note">Only the first {plural(result.matchCount, "result")} are shown. Narrow the search.</span>
        ) : null}
        {!pattern && state.kind === "idle" ? (
          <span className="codespace-search-note">Text in every file of this folder. Files git ignores, and node_modules, are left out.</span>
        ) : null}
      </div>

      {result && result.files.length > 0 ? (
        <ul className="codespace-search-results" aria-label="Search results">
          {result.files.map((file) => (
            <SearchFileGroup
              key={file.path}
              file={file}
              rootDir={rootDir}
              open={!collapsed.has(file.path)}
              onToggle={() => toggleFile(file.path)}
              onOpenMatch={onOpenMatch}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SearchToggle({ label, text, pressed, underline = false, onClick }: {
  label: string;
  text: string;
  pressed: boolean;
  underline?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn("codespace-search-toggle", pressed && "is-active", underline && "underline")}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

function SearchFileGroup({ file, rootDir, open, onToggle, onOpenMatch }: {
  file: EditorSearchFile;
  rootDir: string;
  open: boolean;
  onToggle: () => void;
  onOpenMatch: (path: string, match: EditorSearchMatch) => void;
}) {
  const relative = relativeTo(rootDir, file.path);
  const { name, folder } = splitPath(relative);
  return (
    <li className="codespace-search-file">
      <button
        type="button"
        className="codespace-search-file-row"
        aria-expanded={open}
        title={relative}
        onClick={onToggle}
      >
        <ChevronRight className={cn("codespace-search-chevron h-3 w-3 shrink-0", open && "is-open")} aria-hidden="true" />
        <span className="codespace-search-file-name">{name}</span>
        {folder ? <span className="codespace-search-file-folder">{folder}</span> : null}
        <span className="codespace-search-count" aria-label={plural(file.matches.length, "result")}>{file.matches.length}</span>
      </button>
      {open ? (
        <ul>
          {file.matches.map((match) => (
            <li key={`${match.line}:${match.column}`}>
              <button
                type="button"
                className="codespace-search-match"
                title={`${relative}:${match.line}:${match.column}`}
                onClick={() => onOpenMatch(file.path, match)}
              >
                <span className="sr-only">Line {match.line}: </span>
                {match.preview.slice(0, match.previewStart)}
                <mark>{match.preview.slice(match.previewStart, match.previewStart + match.length)}</mark>
                {match.preview.slice(match.previewStart + match.length)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
