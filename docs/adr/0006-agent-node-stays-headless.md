# Canvas Agent Node stays headless; chrome is added, the PTY is not

## Status

accepted

## Context

A proposal asked whether the **Canvas Agent Node** should be refactored into an
interactive terminal — backed by the **Terminal Pane Runtime**, running `claude`
in a PTY so the user sees the full TUI (numbered choice menus, live prompts) and
a richer header (worktree, skills, IDE, diff, kill, a context-cache timer).

The Agent Node today runs `claude --print --output-format stream-json` headless
and one-shot (`run_codechat`), parsing structured events into the **Agent Run
View**. That structured stream is what the orchestration harness consumes:
plan execution (chaining steps on `result.ok`/exit), the run graph, the Inbox
status, and the SQLite run trace. All of it is TDD'd around pure cores that
parse machine-readable output.

Two facts shaped the decision:

- `--print` (structured, non-interactive) and the interactive TUI are mutually
  exclusive `claude` modes. The numbered choice menu shown in the proposal only
  exists in interactive mode, which emits no structured stream.
- An interactive PTY *invites* the agent to stop and ask — directly opposed to
  orchestrated turns, which must run autonomously with no human watching that
  step. The `HEADLESS_PREAMBLE` exists precisely to suppress that.

A Canvas Terminal Node already exists and can run `claude` interactively today,
so the proposal largely re-creates it while sacrificing the orchestration that
justifies the Agent Node's existence.

## Decision

The Canvas Agent Node **stays headless** (`run_codechat`, `--print`
stream-json). We do **not** move it onto a PTY.

Instead we add the desired *chrome* on top of the existing headless card via a
**Canvas Agent Action Bar**: Diff (uncommitted vs HEAD in the run directory or
assigned worktree), WT (assign a git worktree, repointing the run cwd), Skills
(drag-to-append into the run prompt, guarded), IDE (open the run directory in
the editor), and a visible session id. Every supporting backend command already
exists (`codespace_git`, `list_git_worktrees`, `editor_opener`); this is
frontend wiring, not new runtime.

The interactive context-cache timer from the proposal is dropped — it has no
meaning for a one-shot headless run.

## Considered Options

- **Refactor to interactive PTY (rejected)** — most flexible for a human at the
  keyboard, but unwinds plan/graph/Inbox/trace (they depend on structured
  events), reduces reliability to TUI-output scraping, and duplicates the
  existing Terminal Node.
- **Hybrid: headless default + opt-in PTY take-over (deferred)** — keep headless
  as the substrate, drop a single turn into a PTY when a human chooses to drive.
  Viable later; not needed to satisfy the actual ask, which was visual.
- **Headless + chrome (chosen)** — keep the reliable substrate, add the
  header affordances the proposal really wanted.

## Consequences

- The Agent Node cannot present live interactive choice menus; human-in-the-loop
  steering remains reply-based (resume). Acceptable: orchestrated turns must not
  block on questions anyway, and the Terminal Node covers free interactive use.
- Diff scope is "uncommitted vs HEAD" in the run directory/worktree — accurate
  when each agent runs in its own worktree, but it will show pre-existing dirt
  if an agent shares a working tree. A run-start baseline ("delta this run") is
  the honest upgrade if that becomes a problem.
- Per-node skills delivered by drag are session-only (reset to the definition on
  reload), matching the Terminal Node's Applied-Skill Guard rather than the
  definition's persisted config.
- The headless-vs-PTY question is now answered for future readers who see the
  terminal-style mockup and wonder why the Agent Node is not one.
