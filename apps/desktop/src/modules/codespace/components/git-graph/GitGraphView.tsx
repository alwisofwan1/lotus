import { useVirtualizer } from "@tanstack/react-virtual";
import { Maximize2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { GraphCommit, GraphRef } from "@/lib/tauri/git-graph";
import { SEARCH_LIMIT, useGitGraph, useGitGraphSearch } from "@/modules/codespace/hooks/useGitGraph";
import { laneColumns } from "@/modules/codespace/services/git-graph-lanes";
import type { GraphScope, SyncMark } from "@/modules/codespace/services/git-graph-scope";
import { blameAge } from "@/modules/codespace/services/inline-blame";
import { GitGraphLanes, lanesWidth } from "./GitGraphLanes";
import "@/styles/git-graph.css";

/** Rows are kept in view by key, never by index: a reload can shift every index. */
const UNCOMMITTED = "uncommitted";
/** Rows left below the last one drawn when the next page is asked for. */
const LOAD_AHEAD = 30;

export type GitGraphViewProps = {
  repoRoot: string | null;
  /** The picker's choices (sidebar); one or none hides it. */
  repos?: { root: string; label: string }[];
  onRepoChange?: (root: string) => void;
  /** Editor-tab layout with author, date and hash columns (Q15). */
  wide?: boolean;
  /** On screen: loads, and watches the refs. */
  enabled: boolean;
  /** Files changed in the working tree; above zero shows the "Uncommitted changes" row. */
  uncommitted: number;
  onShowUncommitted?: () => void;
  onOpenCommit: (sha: string, subject: string) => void;
  onOpenWide?: () => void;
  /** The commit open in the editor, drawn as selected. */
  openSha?: string | null;
};

function fullDate(time: number): string {
  const at = new Date(time * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function tooltip(commit: GraphCommit): string {
  return `${commit.subject}\n${commit.author} · ${fullDate(commit.time)} · ${commit.sha.slice(0, 10)}`;
}

function Labels({ refs, max }: { refs: GraphRef[] | undefined; max: number }) {
  if (!refs?.length) return null;
  const rest = refs.slice(max);
  return (
    <span className="gg-refs">
      {refs.slice(0, max).map((ref) => (
        <span
          key={ref.fullName}
          className={cn("gg-ref", ref.isHead && "is-head", ref.kind === "tag" && "is-tag", ref.kind === "remote" && "is-remote", ref.worktree && !ref.isHead && "is-worktree")}
          title={ref.worktree && !ref.isHead ? `${ref.name}, checked out in ${ref.worktree}` : ref.name}
        >
          {ref.name}
        </span>
      ))}
      {rest.length > 0 ? <span className="gg-ref is-more" title={rest.map((ref) => ref.name).join(", ")}>+{rest.length}</span> : null}
    </span>
  );
}

function Sync({ mark }: { mark: SyncMark | undefined }) {
  if (mark === "outgoing") return <span className="gg-sync is-out" title="Not pushed">↑</span>;
  if (mark === "incoming") return <span className="gg-sync is-in" title="On the upstream, not pulled">↓</span>;
  return null;
}

function State({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="gg-state" role="status">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function GitGraphView({
  repoRoot,
  repos = [],
  onRepoChange,
  wide = false,
  enabled,
  uncommitted,
  onShowUncommitted,
  onOpenCommit,
  onOpenWide,
  openSha = null,
}: GitGraphViewProps) {
  const [scope, setScope] = useState<GraphScope>("smart");
  const [query, setQuery] = useState("");
  const graph = useGitGraph({ repoRoot, scope, enabled });
  const search = useGitGraphSearch(repoRoot, graph.refs, query);
  const [selected, setSelected] = useState<string | null>(null);
  const [spin, setSpin] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const rowHeight = wide ? 28 : 38;
  const searching = search.results !== null;
  const showUncommitted = !searching && uncommitted > 0 && Boolean(graph.refs?.head) && !graph.refs?.detached;
  const keys = useMemo(() => {
    if (searching) return search.results!.map((commit) => commit.sha);
    return [...(showUncommitted ? [UNCOMMITTED] : []), ...graph.commits.map((commit) => commit.sha)];
  }, [searching, search.results, showUncommitted, graph.commits]);
  const bySha = useMemo(() => new Map(graph.commits.map((commit, index) => [commit.sha, index])), [graph.commits]);
  const width = lanesWidth(laneColumns(graph.rows));

  const virtualizer = useVirtualizer({
    count: keys.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: (index) => keys[index] ?? index,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length > 0 ? items[items.length - 1]!.index : -1;
  const { hasMore, loadingMore, loadMore } = graph;
  useEffect(() => {
    if (!searching && hasMore && !loadingMore && lastIndex >= keys.length - LOAD_AHEAD) void loadMore();
  }, [searching, hasMore, loadingMore, loadMore, lastIndex, keys.length]);

  const current = selected ?? openSha;
  const select = useCallback((key: string | null, align: "auto" | "center" = "auto") => {
    if (!key) return;
    setSelected(key);
    const index = keys.indexOf(key);
    if (index >= 0) virtualizer.scrollToIndex(index, { align });
  }, [keys, virtualizer]);

  const open = useCallback((key: string) => {
    if (key === UNCOMMITTED) {
      onShowUncommitted?.();
      return;
    }
    const commit = (searching ? search.results : graph.commits)?.find((candidate) => candidate.sha === key);
    setSelected(key);
    onOpenCommit(key, commit?.subject ?? "");
  }, [graph.commits, onOpenCommit, onShowUncommitted, search.results, searching]);

  const goToHead = useCallback(() => {
    setQuery("");
    select(graph.refs?.head ?? null, "center");
    listRef.current?.focus();
  }, [graph.refs?.head, select]);

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = current ? keys.indexOf(current) : -1;
    const commit = current ? graph.commits[bySha.get(current) ?? -1] : undefined;
    let next: string | null | undefined;
    if (event.key === "ArrowDown") next = keys[Math.min(keys.length - 1, index + 1)];
    else if (event.key === "ArrowUp") next = keys[Math.max(0, index - 1)];
    else if (event.key === "ArrowLeft") next = commit?.parents.find((parent) => bySha.has(parent));
    else if (event.key === "ArrowRight") next = current ? graph.commits.find((candidate) => candidate.parents.includes(current))?.sha : undefined;
    else if (event.key === "Enter" && current) {
      event.preventDefault();
      open(current);
      return;
    } else return;
    event.preventDefault();
    select(next ?? null);
  };

  const onRootKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  };

  const refresh = () => {
    setSpin((n) => n + 1);
    void graph.refresh();
  };

  const updated = graph.updatedAt ? new Date(graph.updatedAt).toTimeString().slice(0, 5) : null;
  const refs = graph.refs;
  const notRepo = graph.error !== null && /not a git repository/i.test(graph.error);
  const now = Date.now();

  let body: ReactNode;
  if (!repoRoot || notRepo) {
    body = <State title="Not a git repository.">This folder has no .git. Open a folder inside a repository.</State>;
  } else if (graph.loading) {
    body = <div className="gg-skeleton" aria-label="Loading history">{Array.from({ length: 9 }, (_, i) => <div key={i} className="gg-sk" />)}</div>;
  } else if (graph.error && graph.commits.length === 0) {
    body = (
      <State title="Git could not read the history.">
        <code className="gg-error">{graph.error}</code>
        <button type="button" className="gg-btn" onClick={() => void graph.retry()}>Retry</button>
      </State>
    );
  } else if (refs && !refs.head) {
    body = <State title="No commits yet.">Your first commit will show here.</State>;
  } else if (searching && search.results!.length === 0 && !search.searching) {
    body = <State title={search.error ? "Search failed." : `No commit matches “${query.trim()}”.`}>{search.error}</State>;
  } else {
    body = (
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((item) => {
          const key = keys[item.index]!;
          const style = { position: "absolute" as const, top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start}px)` };
          if (key === UNCOMMITTED) {
            return (
              <div key={key} id={`gg-${key}`} role="option" aria-selected={current === key} className={cn("gg-row is-uncommitted", wide && "is-wide")} style={style} onClick={() => open(key)}>
                <svg className="gg-lanes" width={width} height={rowHeight} aria-hidden="true">
                  <line className="gg-folded" x1={6} y1={rowHeight / 2} x2={6} y2={rowHeight} />
                  <circle className="gg-dot gg-folded" cx={6} cy={rowHeight / 2} r={3.6} />
                </svg>
                <div className="gg-body">
                  <div className="gg-subject"><span className="gg-text">Uncommitted changes</span></div>
                  {!wide ? <div className="gg-meta">{uncommitted} file{uncommitted === 1 ? "" : "s"}</div> : null}
                </div>
              </div>
            );
          }
          const commit = searching ? search.results![item.index]! : graph.commits[bySha.get(key)!]!;
          const row = searching ? null : graph.rows[bySha.get(key)!];
          const merge = commit.parents.length > 1;
          const labels = <Labels refs={graph.labels.get(commit.sha)} max={wide ? 4 : 2} />;
          const lanes = row ? <GitGraphLanes row={row} width={width} height={rowHeight} /> : null;
          const age = blameAge(commit.time, now);
          return (
            <div
              key={key}
              id={`gg-${key}`}
              role="option"
              aria-selected={current === key}
              className={cn("gg-row", wide && "is-wide", merge && "is-merge", searching && "is-flat")}
              style={wide ? { ...style, gridTemplateColumns: `${searching ? 8 : width}px minmax(160px, 1fr) 120px 110px 72px` } : style}
              title={tooltip(commit)}
              onClick={() => open(key)}
            >
              {wide ? (
                <>
                  {lanes ?? <span />}
                  <span className="gg-subject">{labels}<Sync mark={graph.marks.get(commit.sha)} /><span className="gg-text">{commit.subject}</span></span>
                  <span className="gg-col">{commit.author}</span>
                  <span className="gg-col" title={fullDate(commit.time)}>{age}</span>
                  <span className="gg-col gg-mono">{commit.sha.slice(0, 7)}</span>
                </>
              ) : (
                <>
                  {lanes}
                  <div className="gg-body">
                    <div className="gg-subject">{labels}<span className="gg-text">{commit.subject}</span></div>
                    <div className="gg-meta">
                      <Sync mark={graph.marks.get(commit.sha)} />
                      <span>{commit.author} · {age}{searching ? ` · ${commit.sha.slice(0, 7)}` : ""}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const ready = Boolean(repoRoot) && !notRepo && !graph.loading && Boolean(refs?.head);
  const count = search.results?.length ?? 0;
  return (
    <div className={cn("gg-view", wide && "is-wide")} onKeyDown={onRootKey}>
      <div className="gg-top">
        {repos.length > 1 && onRepoChange ? (
          <select className="gg-input" aria-label="Repository" value={repoRoot ?? ""} onChange={(event) => onRepoChange(event.target.value)}>
            {repos.map((repo) => <option key={repo.root} value={repo.root}>{repo.label}</option>)}
          </select>
        ) : null}
        <div className="gg-tools">
          <div className="gg-seg" role="group" aria-label="Branches shown">
            <button type="button" aria-pressed={scope === "smart"} onClick={() => setScope("smart")} title="Current branch, its upstream, main, and branches a worktree has checked out">Smart</button>
            <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")} title="Every local branch">All</button>
          </div>
          <button key={spin} type="button" className={cn("gg-icon", spin > 0 && "is-spinning")} onClick={refresh} title="Refresh" aria-label="Refresh">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {onOpenWide ? (
            <button type="button" className="gg-icon" onClick={onOpenWide} title="Open wide" aria-label="Open wide">
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <input
          ref={searchRef}
          className="gg-input"
          placeholder="Search all history"
          aria-label="Search commits: message, author, hash"
          value={query}
          disabled={!ready}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setQuery("");
              listRef.current?.focus();
            } else if (event.key === "ArrowDown" || event.key === "Enter") {
              event.preventDefault();
              listRef.current?.focus();
              if (!current) select(keys[0] ?? null);
            }
          }}
        />
        {ready ? (
          <div className="gg-fresh">
            <span>{updated ? `Updated ${updated}` : ""}</span>
            <button type="button" onClick={goToHead} title="Select the commit HEAD points at">Go to HEAD</button>
          </div>
        ) : null}
      </div>
      {ready && refs?.detached ? <div className="gg-banner">Detached HEAD at {refs.head!.slice(0, 7)}</div> : null}
      {ready && graph.error ? <div className="gg-banner is-error" title={graph.error}>Could not refresh. Showing the last history read.</div> : null}
      {searching && count > 0 ? (
        <div className="gg-count">{count >= SEARCH_LIMIT ? `${count}+` : count} commit{count === 1 ? "" : "s"} in all history{search.searching ? " …" : ""}</div>
      ) : null}
      {wide && !searching && ready ? (
        <div className="gg-row is-wide is-header" style={{ gridTemplateColumns: `${width}px minmax(160px, 1fr) 120px 110px 72px` }} aria-hidden="true">
          <span /><span>Message</span><span>Author</span><span>Date</span><span>Hash</span>
        </div>
      ) : null}
      <div
        ref={listRef}
        className="gg-list"
        role="listbox"
        aria-label="Commits"
        tabIndex={0}
        aria-activedescendant={current && keys.includes(current) ? `gg-${current}` : undefined}
        onKeyDown={onListKey}
      >
        {body}
        {ready && !searching && !graph.hasMore && refs?.shallow ? <div className="gg-end">History ends here (shallow clone).</div> : null}
        {ready && !searching && graph.loadingMore ? <div className="gg-end">Loading more…</div> : null}
      </div>
    </div>
  );
}
