import { listen } from "@tauri-apps/api/event";
import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/** The Git graph's commands (`src-tauri/src/git_graph/`). Local repositories only; read only. */

export type GraphCommit = {
  sha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** Author time, Unix seconds. */
  time: number;
  subject: string;
};

export type GraphRef = {
  /** `main`, `origin/main`, `v1.0`. */
  name: string;
  /** `refs/heads/main`: what goes back to `gitGraphLog`. */
  fullName: string;
  kind: "local" | "remote" | "tag";
  /** The commit it points at (a tag is peeled). */
  target: string;
  /** A local branch's upstream, short (`origin/main`). */
  upstream: string | null;
  /** Checked out in this working tree. */
  isHead: boolean;
  /** The working tree that has this branch checked out, this one or another. */
  worktree: string | null;
};

export type GraphRefs = {
  /** Null in a repository with no commit yet. */
  head: string | null;
  detached: boolean;
  shallow: boolean;
  defaultBranch: string | null;
  refs: GraphRef[];
  /** On HEAD, not on its upstream. */
  outgoing: string[];
  /** On the upstream, not on HEAD. */
  incoming: string[];
};

export type CommitFile = {
  /** `A`, `M`, `D`, `R`, `C` or `T`. */
  status: string;
  /** Repo-relative, `/`-separated. */
  path: string;
  oldPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type CommitDetail = GraphCommit & {
  message: string;
  /** Against the first parent. */
  files: CommitFile[];
  filesTruncated: boolean;
  /** `origin` on GitHub, as a web page. */
  githubUrl: string | null;
};

export type CommitFilePair = {
  original: string | null;
  modified: string | null;
  binary: boolean;
  /** A side is over 1 MB and `allowLarge` was off: nothing was read. */
  tooLarge: boolean;
};

function desktopOnly(): void {
  if (!isTauri()) throw new Error("Desktop app required for the Git graph.");
}

export async function gitGraphRefs(repoRoot: string): Promise<GraphRefs> {
  desktopOnly();
  return tauriInvoke<GraphRefs>("git_graph_refs", { repoRoot });
}

export async function gitGraphLog(repoRoot: string, revs: string[], skip: number, limit: number): Promise<GraphCommit[]> {
  desktopOnly();
  return tauriInvoke<GraphCommit[]>("git_graph_log", { repoRoot, revs, skip, limit });
}

export async function gitGraphSearch(repoRoot: string, revs: string[], query: string, limit: number): Promise<GraphCommit[]> {
  desktopOnly();
  return tauriInvoke<GraphCommit[]>("git_graph_search", { repoRoot, revs, query, limit });
}

export async function gitGraphCommit(repoRoot: string, sha: string): Promise<CommitDetail> {
  desktopOnly();
  return tauriInvoke<CommitDetail>("git_graph_commit", { repoRoot, sha });
}

export async function gitGraphFilePair(
  repoRoot: string,
  sha: string,
  parent: string | null,
  file: Pick<CommitFile, "path" | "oldPath" | "status">,
  allowLarge = false,
): Promise<CommitFilePair> {
  desktopOnly();
  return tauriInvoke<CommitFilePair>("git_graph_file_pair", {
    repoRoot,
    sha,
    parent,
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    allowLarge,
  });
}

let watchSeq = 0;

/**
 * Calls `onMoved` when a branch, tag or HEAD of `repoRoot` moves (debounced in Rust), until the
 * returned stop is called. Each call has its own watch id, so a late stop never ends a newer watch.
 */
export function watchGitRefs(repoRoot: string, onMoved: () => void): () => void {
  if (!isTauri()) return () => {};
  watchSeq += 1;
  const watchId = `git-graph:${watchSeq}`;
  let stopped = false;
  const pending = listen<{ watchId: string }>("git-graph://refs-moved", (event) => {
    if (!stopped && event.payload.watchId === watchId) onMoved();
  }).catch(() => null);
  const started = tauriInvoke("git_graph_watch", { watchId, repoRoot }).catch((error) => {
    console.warn("[git-graph] could not watch", repoRoot, error);
  });
  return () => {
    stopped = true;
    void pending.then((off) => off?.());
    void started.then(() => tauriInvoke("git_graph_unwatch", { watchId })).catch(() => {});
  };
}
