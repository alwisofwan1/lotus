"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import {
  codespaceGitDiscoverRepos,
  codespaceGitStatusFor,
  codespaceGitRepoSummaryFor,
  type CodespaceGitFileStatus,
  type CodespaceGitRepoSummary,
  type CodeSpaceStoredWorkspaceLocation,
} from "@/lib/tauri/codespace";

export type GitRepoState = {
  rootDir: string;
  statuses: CodespaceGitFileStatus[];
  summary: CodespaceGitRepoSummary | null;
  available: boolean;
  loading: boolean;
  error: string | null;
};

export type UseMultiRepoGitOptions = {
  roots: string[];
  location: CodeSpaceStoredWorkspaceLocation | null;
  enabled: boolean;
};

export type UseMultiRepoGitResult = {
  repos: Map<string, GitRepoState>;
  loading: boolean;
  totalChanges: number;
  refreshAll: () => Promise<void>;
  refreshRepo: (rootDir: string) => Promise<void>;
};

function emptyRepoState(rootDir: string): GitRepoState {
  return { rootDir, statuses: [], summary: null, available: false, loading: true, error: null };
}

async function fetchRepoState(
  rootDir: string,
  location: CodeSpaceStoredWorkspaceLocation | null,
): Promise<GitRepoState> {
  try {
    const statuses = await codespaceGitStatusFor(location, { repoRoot: rootDir });
    let summary: CodespaceGitRepoSummary | null = null;
    try {
      summary = await codespaceGitRepoSummaryFor(location, { repoRoot: rootDir });
    } catch { /* summary optional */ }
    return { rootDir, statuses, summary, available: true, loading: false, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { rootDir, statuses: [], summary: null, available: false, loading: false, error: message };
  }
}

const EMPTY_MAP = new Map<string, GitRepoState>();

export function useMultiRepoGit({ roots, location, enabled }: UseMultiRepoGitOptions): UseMultiRepoGitResult {
  const [repos, setRepos] = useState<Map<string, GitRepoState>>(EMPTY_MAP);
  const locationRef = useRef(location);
  useEffect(() => { locationRef.current = location; }, [location]);

  // Stabilize roots array reference.
  const rootsKey = roots.join("\0");
  const stableRoots = useMemo(() => roots, [rootsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchAndSet = useCallback(async (rootDir: string) => {
    const state = await fetchRepoState(rootDir, locationRef.current);
    setRepos((prev) => new Map(prev).set(rootDir, state));
  }, []);

  const refreshAll = useCallback(async () => {
    if (!enabled || !isTauri()) return;
    // Re-discover repos then fetch each
    const discovered = await codespaceGitDiscoverRepos(stableRoots[0]);
    setRepos(new Map(discovered.map((r) => [r, emptyRepoState(r)])));
    await Promise.all(discovered.map(fetchAndSet));
  }, [enabled, stableRoots, fetchAndSet]);

  const refreshRepo = useCallback(async (rootDir: string) => {
    if (!enabled || !isTauri()) return;
    await fetchAndSet(rootDir);
  }, [enabled, fetchAndSet]);

  // Initial discovery + fetch when inputs change.
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    void (async () => {
      // Discover git repos within the primary workspace root
      const discovered = await codespaceGitDiscoverRepos(stableRoots[0]);
      setRepos(new Map(discovered.map((r) => [r, emptyRepoState(r)])));
      await Promise.all(discovered.map(fetchAndSet));
    })();
  }, [enabled, stableRoots, fetchAndSet]);

  const loading = [...repos.values()].some((r) => r.loading);
  const totalChanges = [...repos.values()].reduce((sum, r) => sum + r.statuses.length, 0);
  const result = enabled ? repos : EMPTY_MAP;

  return { repos: result, loading, totalChanges, refreshAll, refreshRepo };
}
