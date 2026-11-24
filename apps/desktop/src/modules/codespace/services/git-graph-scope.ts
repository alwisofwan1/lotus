import type { GraphRef, GraphRefs } from "@/lib/tauri/git-graph";

/**
 * Which branches the Git graph draws (Q13). **Smart**: the current branch, its upstream, the
 * default branch and its upstream, and every branch a worktree has checked out (agents work in
 * worktrees). **All**: every local branch and its upstream. Lotus makes many `agent/*` branches,
 * so Smart is the default.
 */
export type GraphScope = "smart" | "all";

export function scopeRefs(refs: GraphRefs, scope: GraphScope): GraphRef[] {
  const byName = new Map(refs.refs.filter((ref) => ref.kind !== "tag").map((ref) => [ref.name, ref]));
  const picked = new Map<string, GraphRef>();
  const add = (ref: GraphRef | undefined) => {
    if (!ref || picked.has(ref.fullName)) return;
    picked.set(ref.fullName, ref);
    if (ref.upstream) add(byName.get(ref.upstream));
  };
  for (const ref of refs.refs) {
    if (ref.kind !== "local") continue;
    if (scope === "all" || ref.isHead || ref.worktree !== null || ref.name === refs.defaultBranch) add(ref);
  }
  // A default branch known only as `origin/main`.
  if (refs.defaultBranch) add(byName.get(refs.defaultBranch));
  return [...picked.values()];
}

/** What `gitGraphLog` walks from. HEAD always: a detached HEAD is no branch at all. */
export function scopeRevs(refs: GraphRefs, scope: GraphScope): string[] {
  if (!refs.head) return [];
  return ["HEAD", ...scopeRefs(refs, scope).map((ref) => ref.fullName)];
}

/** Whole-history search looks everywhere, whatever the scope (Q14). */
export function searchRevs(refs: GraphRefs): string[] {
  if (!refs.head) return [];
  return ["HEAD", ...refs.refs.map((ref) => ref.fullName)];
}

/**
 * Labels per commit: the drawn branches, their remotes and every tag. Order: HEAD's branch, then
 * other local, remote, tag. A branch outside the scope gets no label, or a commit would claim a
 * name whose line is not drawn.
 */
export function labelsByCommit(refs: GraphRefs, scope: GraphScope): Map<string, GraphRef[]> {
  const shown = new Set(scopeRefs(refs, scope).map((ref) => ref.fullName));
  const rank = (ref: GraphRef) => (ref.isHead ? 0 : ref.kind === "local" ? 1 : ref.kind === "remote" ? 2 : 3);
  const labels = new Map<string, GraphRef[]>();
  for (const ref of refs.refs) {
    if (ref.kind !== "tag" && !shown.has(ref.fullName)) continue;
    const list = labels.get(ref.target) ?? [];
    list.push(ref);
    labels.set(ref.target, list);
  }
  for (const list of labels.values()) list.sort((a, b) => rank(a) - rank(b));
  return labels;
}

export type SyncMark = "outgoing" | "incoming";

export function syncMarks(refs: GraphRefs): Map<string, SyncMark> {
  const marks = new Map<string, SyncMark>();
  for (const sha of refs.outgoing) marks.set(sha, "outgoing");
  for (const sha of refs.incoming) marks.set(sha, "incoming");
  return marks;
}
