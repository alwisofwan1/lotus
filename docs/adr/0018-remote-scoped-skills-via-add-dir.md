# Remote-Scoped Skills via `--add-dir`, signalled by Remote Session Scope

## Status

accepted — **implementation scope amended**: to keep the first implementation
strictly inside `lotus-remote/` (no `src-tauri/` changes), **V1 ships the
standalone spawner only**; the **client-mode (Rust desktop) path is deferred**.
The wire contract below stands; only the Rust honouring of it is postponed.

## Context

A mobile operator drives Lotus from Telegram through **lotus-remote**. The user
wants extra Agent Skills available to the agent **only** during these
remote-initiated sessions — e.g. "mobile operator" workflows — without those
skills appearing during a normal local desktop coding session, and without
polluting either the user's personal global skills (`~/.claude/skills`) or a
project's committed skills (`.claude/skills`). See **Remote-Scoped Skill** and
**Remote Session Scope** in CONTEXT.md.

The agent CLI is the consumer of skills, not the bot UX. Two distinct spawn
paths exist:

- **client mode** (default): Telegram → lotus-remote → the **desktop app
  (Rust)** spawns `claude` (`bridge_chat` and the PTY/agent spawn paths).
  lotus-remote (TS) cannot inject CLI flags here — the Rust side spawns.
- **standalone mode**: lotus-remote's own `AgentRunner`
  (`src/server/agent/runners/claude.ts`) spawns `claude` directly.

Investigation of the available levers (verified against Claude Code and Codex
docs, June 2026):

- Claude Code auto-discovers skills from `.claude/skills`, `~/.claude/skills`,
  plugins, and **`--add-dir <path>`** — a dir passed via `--add-dir` has its
  `<path>/.claude/skills/` automatically discovered and live-reloaded, while
  granting file read access only to that subtree. This is the one clean
  per-invocation lever with zero pollution.
- `CLAUDE_CONFIG_DIR` would relocate the *entire* config root, so a skills-only
  custom dir **loses the user's authentication and session-resume** — rejected.
- There is no `--skills-dir` flag and no `extraSkillDirs` settings key.
- **Codex** discovers skills from `.agents/skills` (repo) and `$HOME/.agents/skills`
  (user), invoked by typing `$` or `/skills`. Codex has **no `--add-dir`
  equivalent and no per-invocation skill-dir flag**. Clean remote-scoping would
  require an `HOME` override (to relocate `~/.agents/skills`) paired with a
  separate `CODEX_HOME` (to preserve `~/.codex` auth) — fragile and unverified.
  Open OpenAI feature requests track per-invocation skill loading.
- **ccs** is a profile wrapper with its own argument parsing; it offers no
  guarantee that `--add-dir` is forwarded to the underlying claude.

## Decision

- Introduce **Remote-Scoped Skills** materialised under an isolated mount:
  `~/.lotus-remote/agent-mount/.claude/skills/<name>/SKILL.md`. Any
  configuration or secrets under `~/.lotus-remote/` live **outside** the mount,
  so `--add-dir` never exposes them to the agent.
- Remote spawn/chat requests carry a **semantic flag** (`remoteScoped: true`),
  not a filesystem path. Each spawner resolves the flag to **its own** mount
  location. No absolute path is sent over the wire, so a remote caller cannot
  inject an arbitrary `--add-dir` target.
- Both spawners honour the same flag:
  - **standalone** (`runners/claude.ts`): append `--add-dir <mount>` to the
    `chat()` args and to the `spawnPty` command string.
  - **client** (Rust desktop): the `bridge_chat` and PTY/agent spawn paths
    append `--add-dir <mount>` when the request is flagged.
- **V1 honours `claude` only** (claude runner + bridge chat). `codex` and `ccs`
  treat the flag as a documented **no-op** — the flag is accepted but skills are
  not injected.
- **V1 is skills-only.** lotus-remote runtime config stays in `.env` and the
  `~/.lotus/api-server.json` discovery file; `.lotus-remote/` is not yet a
  general config home.
- **V1 management is manual file editing.** No Telegram command or desktop UI to
  create/enable Remote-Scoped Skills yet.

## Consequences

- Local desktop sessions are guaranteed untouched: they never set the flag, so
  they never see Remote-Scoped Skills, and global/project skills are never
  written to.
- The flag becomes a **cross-codebase wire contract** (lotus-remote TS request
  body ↔ Rust desktop spawn paths ↔ standalone TS runner). Changing its
  semantics later requires coordinating both sides — this is the main
  reversibility cost.
- Reviewers will see `--add-dir ~/.lotus-remote/agent-mount` appended only for
  remote sessions; this ADR is the "why".
- Codex remote-scoped skills are explicitly **deferred**. A separate spike must
  verify whether codex cleanly separates `HOME` (`.agents/skills`) from
  `CODEX_HOME` (`.codex` auth) before any codex support is attempted. Until
  then, a Telegram session driving a codex runner silently gets no remote skills
  (documented, not a bug).
- ccs is also deferred for the same forwarding-uncertainty reason.
- If `.lotus-remote/` later grows into a general config home (rejected for V1),
  it must keep the secrets/skills isolation boundary established here: anything
  reachable by `--add-dir` must contain skills only.
