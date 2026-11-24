# ADR 0015 — Per-agent worktree isolation is opt-in at team launch, not auto-created per node

**Status**: Accepted

## Context

The competitive audit (June 2026) found that **per-agent isolation** is table-stakes
for multi-agent coding tools (Conductor, Crystal/Nimbalyst, Claude Squad use git
worktrees; Sculptor uses containers), and that it is the keystone that unlocks
per-agent diff review, rollback, and isolated verification. Lotus runs multiple
agents but, by default, multiple AgentNodes/TerminalNodes in one workspace share a
single working directory, so parallel agents can clobber each other's edits and
there is no clean per-agent changeset to review.

Most of the machinery already exists:

- **Worktree CRUD** in `src-tauri/src/codespace_git.rs`: `create_git_worktree`
  (`git worktree add <path> <branch>`, falls back to `-b`), `remove_git_worktree`,
  `validate_worktree_branches`, `list_git_worktrees`. Exposed as Tauri commands and
  in `main-app-commands.toml`.
- **Run-cwd routing** is wired end-to-end: `useAgentNodeActions` exposes
  `runCwd = worktree?.path ?? cwd`, and `run_codechat` (`codechat.rs`) sets
  `cmd.current_dir(dir)`. An AgentNode with an assigned worktree **already runs
  inside it**. Terminal nodes auto-`cd` into the worktree on assign.
- **Persistence**: `assignedWorktree` + `assignedWorktreePath` round-trip through
  `CanvasTerminalNodeRecord` / `CanvasAgentNodeRecord` and `canvas-serialize.ts`;
  stale assignments are cleared on project switch (`validateWorktreeAssignments`).
- **Diff** primitives exist: `codespace_git_diff_file`, `codespace_git_diff_file_content`,
  `git diff --staged --stat`.

The missing piece is purely the **automatic** part. ADR-adjacent prior work — the
`canvas-worktree-redesign` (done 2026-06-05) — deliberately rejected auto-create:

> "TIDAK ada auto-create worktree saat Terminal node dibuka → dirty branch.
> Pembuatan worktree HARUS eksplisit dari user."

That constraint exists to stop orphan/dirty branches proliferating every time a user
opens a bare node. A naive "auto-worktree per AgentNode on spawn" would violate it.

So the real question is **how** to add automatic isolation without reintroducing
branch proliferation.

## Decision

Per-agent worktree isolation is an **opt-in capability scoped to an explicit team /
swarm launch**, not automatic behavior on bare node creation.

1. **Opt-in at launch, not per node.** A canvas team template (ADR 0007) and the
   spawn flow gain an **"Isolate agents"** toggle. When on, every agent spawned by
   that launch is auto-assigned a freshly-created worktree; when off, behavior is
   unchanged (shared cwd + the existing manual worktree affordance). This preserves
   the canvas-worktree-redesign rule — creation is still **explicit from the user**,
   just at team-launch granularity rather than per-node-open.

2. **Reuse the existing assignment path.** Auto-isolation = create a worktree via
   `create_git_worktree` on a generated branch, then drive the *existing*
   `onWorktreeChange(nodeId, branch, path)` → `patchNodeData` → `runCwd` wiring. No
   new run-cwd plumbing; the agent already runs in `runCwd`.

3. **Deterministic naming off a base branch.** Branch `lotus/<teamSlug>/<agentSlug>`,
   worktree path `<repo>/../.lotus-worktrees/<teamSlug>/<agentSlug>`, branched from a
   recorded **base branch** (default: the repo's current HEAD branch at launch). The
   base branch is persisted on the team/agent record so diff and merge have a target.

4. **Lifecycle is bounded by an explicit terminal action.** A worktree is reaped
   (`remove_git_worktree` + branch delete) only on an explicit **Accept** (merge to
   base) or **Discard**, or a **Clean up worktrees** action — never silently. Stale
   worktrees from a crashed/closed session are surfaced and cleared via the existing
   `validate_worktree_branches` hydration path plus a "clean up" affordance.

5. **Per-agent review surface.** Each isolated agent gets a diff of
   `git diff <baseBranch>...<agentBranch>` (reusing `codespace_git` diff primitives)
   in the Agent Action Bar (ADR 0006), with Accept / Discard / Request-changes.
   Request-changes reuses the existing resume/sendReply path.

## Consequences

- Parallel agents in an isolated launch cannot corrupt each other's files; each
  produces a clean, reviewable branch.
- Per-agent diff review and one-click merge become possible — closing the biggest
  table-stakes gap from the audit — without new isolation infrastructure.
- A **base branch** concept is introduced and must be persisted per team/agent; diff
  and merge target it.
- **Merge conflicts** at Accept time are now possible. The first delivery surfaces a
  conflict and blocks the merge with a clear message; agent-assisted conflict
  resolution (à la Sculptor) is an explicit follow-on, not in scope here.
- Worktrees consume disk and share the repo object store; the `.lotus-worktrees/`
  convention and explicit reaping keep the footprint bounded, but a user who never
  Accepts/Discards will accumulate worktrees until they run Clean up.
- Containerized isolation (Sculptor-style) is explicitly **out of scope**; worktrees
  are the chosen primitive, consistent with the existing `codespace_git` investment.
- The opt-out path (toggle off) is byte-for-byte the current behavior, so this is
  additive and low-risk to existing single-node workflows.
