/**
 * Deterministic, collision-safe naming for per-agent worktree isolation
 * (ADR 0015). Pure — no IO — so the orchestration layer can compute branch and
 * path names without touching git.
 */

/**
 * Slugify a label into a token safe for BOTH a git branch component and a
 * filesystem path segment: lowercase, runs of non-`[a-z0-9]` collapse to a
 * single dash, leading/trailing dashes trimmed. Falls back to `"agent"` when
 * nothing slug-worthy remains.
 */
export function slugify(label: string): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "agent";
}

/**
 * Git branch ref for an isolated agent: `lotus/<teamSlug>/<agentSlug>`. Inputs
 * are expected pre-slugged (see {@link slugify}) so the branch and worktree path
 * stay consistent; this is a pure composer.
 */
export function agentBranchName(teamSlug: string, agentSlug: string): string {
  return `lotus/${teamSlug}/${agentSlug}`;
}

/**
 * Worktree directory for an isolated agent: a `.lotus-worktrees/<team>/<agent>`
 * directory placed *beside* the repo (never nested inside it — git rejects that).
 * Uses POSIX `/` segments, consistent with the existing canvas worktree code.
 * `repoPath` is expected absolute; a trailing slash is tolerated.
 */
export function agentWorktreePath(
  repoPath: string,
  teamSlug: string,
  agentSlug: string,
): string {
  const parent = repoPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return `${parent}/.lotus-worktrees/${teamSlug}/${agentSlug}`;
}

/**
 * Disambiguate `base` against `existing` slugs by appending the lowest free
 * numeric suffix (`base`, `base-2`, `base-3`, …). Keeps auto-created branches
 * unique when two agents slugify to the same token.
 */
export function uniqueSlug(base: string, existing: readonly string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
