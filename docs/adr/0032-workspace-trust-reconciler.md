# ADR 0032 — Workspace Trust Reconciler: pre-trust project dirs in each agent CLI's native config

**Status**: Accepted

## Context

CodeCanvas is an Agent Development Environment: a user opens a project directory and dispatches agent CLIs (`claude`, `codex`, `cursor-agent`, `qwen`) against it, headlessly, via `--print`/stream-json. For a seamless experience the user should configure as little as possible.

Each agent CLI enforces a **workspace trust** gate that is **separate from the per-tool approval gate**. Approval bypass flags do *not* satisfy trust:

- `claude --dangerously-skip-permissions` does **not** mark a workspace trusted. With trust absent, Claude ignores the project's `.claude/settings.local.json` `permissions.allow` entries and prints:

  > `Ignoring N permissions.allow entries from .claude/settings.local.json: this workspace has not been trusted…`

  On recent Claude versions the trust dialog can **block headless execution entirely**, not merely warn (upstream issues #28506, #36342 "blocks agent team"). So this is a reliability risk, not cosmetic noise.
- `codex --dangerously-bypass-approvals-and-sandbox` (`--yolo`) bypasses approvals but **untrusted projects still skip the project-scoped `.codex/` layer** (upstream issue #14345).

Where each tool reads trust (verified against official docs, 2026-06):

| Agent | Trust store | Mechanism |
|---|---|---|
| Claude | `~/.claude.json` → `projects["<abs>"].hasTrustDialogAccepted: true` | **file** (no CLI flag exists to auto-accept) |
| Codex | `~/.codex/config.toml` → project trust level (`trust_level = "trusted"`) | **file** (no auto-trust flag) |
| Cursor | not persisted | **flag** `--trust` (already passed, `codechat_provider.rs:505`) |
| Qwen | n/a (approval only) | **flag** `--yolo` (already passed) |

Two structural facts about Lotus (verified read-only):

1. **No config-dir redirection.** Lotus does not set `CLAUDE_CONFIG_DIR`/`CODEX_HOME` when spawning; the spawned CLI inherits the user's global `~/.claude.json` / `~/.codex`. Lotus's own dev/release split (`~/.lotus-dev` vs `~/.lotus`, `paths.rs:43`) covers only Lotus state, never CLI config.
2. **`CLAUDE_CONFIG_DIR` may already be set by the inherited env** — `shell_env.rs:34` shows `ccs` can set it. So "the user's Claude config" is *not* unconditionally `~/.claude.json`.

The naive idea — "store trust in `.lotus`/`.lotus-dev` so all agents read it" — is a category error: no CLI reads Lotus state. Redirecting every CLI's config dir into `.lotus` via `CLAUDE_CONFIG_DIR` was considered and rejected (see below).

## Decision

Introduce a **Workspace Trust Reconciler**: a Rust module that, when a project is registered, writes the trust marker into **each file-based provider's own native config**, idempotently and merge-safely.

**Separation of concerns:**

- **Intent** (which dirs the user trusts) lives in Lotus state — the existing `codecanvas_projects` table. Opening a project *is* the trust signal.
- **Enforcement** lives in each CLI's native config — the reconciler's job. `.lotus`/`.lotus-dev` is never read by a CLI.

**Trigger point:** at project registration — `codecanvas_store::open_project` (`codecanvas_store.rs:209`). One reconcile per project open; idempotent so re-opens are cheap.

**Provider adapters (iteration 1 — file-based only):**

- **Claude** — merge `projects["<abs>"].hasTrustDialogAccepted = true` into the Claude config JSON. The target file is resolved from the **effective** config dir: honor an inherited `CLAUDE_CONFIG_DIR` if present, else `~/.claude.json`. Read-modify-write that preserves every other key (credentials, `mcpServers`, all other projects).
- **Codex** — ensure `trust_level = "trusted"` for the project under `~/.codex/config.toml` (resolved via `CODEX_HOME`, default `~/.codex`). TOML read-modify-write, key confirmed against the installed `codex` version during implementation.

**Flag-based providers (Cursor `--trust`, Qwen `--yolo`)** already satisfy trust at spawn time; no file write. The adapter trait still has a slot for them so coverage is uniform and future providers ("cloud", etc.) plug in by adding one adapter.

**Safety invariants (non-negotiable):**

1. **Honor the effective config dir** — write to the file the spawned CLI will actually read, not a hardcoded path.
2. **Merge-safe** — never clobber `~/.claude.json`; it holds OAuth credentials, the `mcpServers.lotus` registration, and every other project.
3. **Serialized writes** — a mutex around read-modify-write, because concurrent dispatches can reconcile in parallel (mirrors the per-workspace lock pattern from the bridge task store).
4. **Fail-open** — a reconcile failure logs and proceeds; it must never block opening a project or dispatching.

## Considered options

- **Redirect each CLI to a `.lotus`-owned config dir via `CLAUDE_CONFIG_DIR`/`CODEX_HOME`** — *rejected.* It would orphan the user's auth + `mcpServers.lotus` registration (the whole config moves, not just trust), `CLAUDE_CONFIG_DIR` is unofficial and unevenly supported, and Cursor has no config-dir env at all — so it can never be uniform across providers.
- **Rely on `--dangerously-skip-permissions` / `--yolo` alone** — *rejected.* They bypass approvals, not trust; the warning persists and newer Claude can hard-block.
- **Reconcile just-in-time before every spawn instead of at open** — *deferred.* More consistent per-run but adds I/O per dispatch; revisit as a cheap pre-spawn guard if open-time proves insufficient (e.g. a provider enabled after open).
- **Prompt the user with an in-app trust dialog** — *rejected* for the default path; opening a project in CodeCanvas is itself the trust act. (An opt-out setting can be layered later for the security-conscious.)

## Consequences

- The reported warning disappears and headless dispatch stops being at risk of trust-blocking, with zero manual config per project.
- Lotus now mutates the user's global `~/.claude.json` / `~/.codex/config.toml` (trust keys only, merge-safe). This is shared with the user's own CLI usage — acceptable because trust acceptance is per-directory and benign, but it must be documented.
- New providers require a new adapter; there is deliberately no universal trust file.
- Dev and release Lotus both write the same global CLI trust keys (no redirection) — consistent with today's spawn model.
