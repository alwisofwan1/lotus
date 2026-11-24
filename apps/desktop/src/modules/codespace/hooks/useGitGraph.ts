"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  gitGraphLog,
  gitGraphRefs,
  gitGraphSearch,
  watchGitRefs,
  type GraphCommit,
  type GraphRefs,
} from "@/lib/tauri/git-graph";
import { layoutLanes } from "@/modules/codespace/services/git-graph-lanes";
import { labelsByCommit, scopeRevs, searchRevs, syncMarks, type GraphScope } from "@/modules/codespace/services/git-graph-scope";

export const GRAPH_PAGE = 200;
/** Most rows one reload asks for again; past it the list starts over at this size. */
const MAX_RELOAD = 1000;
export const SEARCH_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 250;

export type GitGraphState = {
  refs: GraphRefs | null;
  commits: GraphCommit[];
  /** First load only; a reload keeps the rows on screen. */
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** When the graph last matched the repository (epoch ms). */
  updatedAt: number | null;
};

const EMPTY: GitGraphState = { refs: null, commits: [], loading: true, error: null, hasMore: false, loadingMore: false, updatedAt: null };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One repository's graph while `enabled` (on screen): loads on open, follows the refs watcher,
 * pages on demand. Every load has a generation; a slower, older answer never lands over a newer one.
 */
export function useGitGraph({ repoRoot, scope, enabled }: { repoRoot: string | null; scope: GraphScope; enabled: boolean }) {
  const [state, setState] = useState<GitGraphState>(EMPTY);
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const reload = useCallback(async (fresh: boolean) => {
    if (!repoRoot) return;
    const gen = ++generation.current;
    if (fresh) setState(EMPTY);
    try {
      const refs = await gitGraphRefs(repoRoot);
      const limit = fresh ? GRAPH_PAGE : Math.min(MAX_RELOAD, Math.max(GRAPH_PAGE, stateRef.current.commits.length));
      const commits = await gitGraphLog(repoRoot, scopeRevs(refs, scope), 0, limit);
      if (gen !== generation.current) return;
      setState({ refs, commits, loading: false, error: null, hasMore: commits.length === limit, loadingMore: false, updatedAt: Date.now() });
    } catch (error) {
      if (gen !== generation.current) return;
      setState((prev) => ({ ...prev, loading: false, loadingMore: false, error: message(error) }));
    }
  }, [repoRoot, scope]);

  const loadMore = useCallback(async () => {
    const { refs, hasMore, loadingMore, commits } = stateRef.current;
    if (!repoRoot || !refs || !hasMore || loadingMore) return;
    const gen = generation.current;
    setState((prev) => ({ ...prev, loadingMore: true }));
    try {
      const page = await gitGraphLog(repoRoot, scopeRevs(refs, scope), commits.length, GRAPH_PAGE);
      if (gen !== generation.current) return;
      setState((prev) => ({ ...prev, commits: [...prev.commits, ...page], hasMore: page.length === GRAPH_PAGE, loadingMore: false }));
    } catch (error) {
      if (gen !== generation.current) return;
      setState((prev) => ({ ...prev, loadingMore: false, error: message(error) }));
    }
  }, [repoRoot, scope]);

  // A new repo or scope starts over; so does coming back on screen after being away.
  useEffect(() => {
    if (!enabled || !repoRoot) return;
    void reload(true);
  }, [enabled, repoRoot, reload]);

  useEffect(() => {
    if (!enabled || !repoRoot) return;
    return watchGitRefs(repoRoot, () => void reload(false));
  }, [enabled, repoRoot, reload]);

  const rows = useMemo(() => layoutLanes(state.commits), [state.commits]);
  const labels = useMemo(() => (state.refs ? labelsByCommit(state.refs, scope) : new Map()), [state.refs, scope]);
  const marks = useMemo(() => (state.refs ? syncMarks(state.refs) : new Map()), [state.refs]);

  return {
    ...state,
    rows,
    labels,
    marks,
    refresh: useCallback(() => reload(false), [reload]),
    retry: useCallback(() => reload(true), [reload]),
    loadMore,
  };
}

export type GitGraphSearch = { results: GraphCommit[] | null; searching: boolean; error: string | null };

type Answer = { repoRoot: string; refs: GraphRefs; query: string; results: GraphCommit[]; error: string | null };

/** Whole-history search (Q14), debounced; `null` results while the query is empty. */
export function useGitGraphSearch(repoRoot: string | null, refs: GraphRefs | null, query: string): GitGraphSearch {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const trimmed = query.trim();
  useEffect(() => {
    if (!repoRoot || !refs || !trimmed) return;
    let live = true;
    const timer = window.setTimeout(() => {
      gitGraphSearch(repoRoot, searchRevs(refs), trimmed, SEARCH_LIMIT)
        .then((results) => live && setAnswer({ repoRoot, refs, query: trimmed, results, error: null }))
        .catch((error) => live && setAnswer({ repoRoot, refs, query: trimmed, results: [], error: message(error) }));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [repoRoot, refs, trimmed]);
  if (!repoRoot || !refs || !trimmed) return { results: null, searching: false, error: null };
  const current = answer?.repoRoot === repoRoot && answer.refs === refs && answer.query === trimmed;
  // While the next answer is on its way, the last one stays on screen.
  if (!current) return { results: answer?.results ?? [], searching: true, error: null };
  return { results: answer.results, searching: false, error: answer.error };
}
