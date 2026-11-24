# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working principle: verify, don't assume (avoid AI slop)

Do **not** propose or ship a fix based on a plausible assumption. Get ground truth first — add
instrumentation, read the actual logs/state, and confirm the mechanism — *then* change code. A
speculative fix shipped without evidence is AI slop and wastes real build/test cycles.

- Before any fix, ask: "what observation would PROVE this is the cause?" If you can't cite evidence
  you have actually seen, you are guessing — instrument instead.
- When one layer is confirmed but the next is unknown, instrument the **unknown** layer; never assume
  it behaves as expected (e.g. "the data reached Rust" does not mean "the webview played it").
- Route diagnostics to where the user is already looking (e.g. the Rust dev terminal via a small
  logging command) rather than asking for extra manual steps round after round. That command
  exists: `invoke("log_canvas_browser_annotation_trace", { line })` prints any line, ungated, to
  the `tauri:dev` terminal (`s2sDebugLog` prints only under `LOTUS_S2S_DEBUG=1`). Tag the lines
  (`[DEBUG-x]`) and remove them before committing.
- Don't generalize from an adjacent path: this app is a **macOS WKWebView (Tauri)** — Web Audio
  `AudioContext.destination` output is unreliable/silent here; `HTMLAudioElement` playback works.
  Confirm the exact code path, not a similar one.
- It is better to say "I need one diagnostic round to see X" than to ship another blind guess.

## This repo is public: no real names in code, tests, comments or commits

Use placeholders only: `Acme` / `acme-web` / `acme-api` for an org and its repos, `Orbit` for a project,
`TKT-123` for a ticket key, `U0EXAMPLE01` for a Slack ID, `dev@example.com` for an email. Never copy a
real customer, ticket, Slack message, workspace name, host or IP from your memory or the session into
this repo — not even into a test fixture. `tools/check-private-terms.sh` blocks known private terms
(pre-commit, commit-msg, pre-push and CI); its list lives outside the repo on purpose. Enable the hooks once per
clone with `git config core.hooksPath .githooks`. Plans and mockups stay outside this repo.

## Repository layout

Lotus is a **meta-repository**. Nothing application-level lives at the root:

```
apps/desktop/          Tauri 2 + Next.js desktop workbench  (src/, src-tauri/, scripts/)
apps/pocket/           Lotus Pocket — Flutter mobile client  (lib/, test/, tool/, scripts/)
packages/host/         Host layer: PTY, agent runners, Standalone Host  (was lotus-remote/)
contract/              Cross-app API spec consumed by desktop and pocket  (fixtures + README)
tools/remotion-bar-chart/
brand/                 Logo and app-icon masters
docs/                  Cross-app docs and ADRs
CLAUDE.md GLOSSARY.md PRODUCT.md DESIGN.md AGENTS.md README.md
```

**Path convention in this file and in `GLOSSARY.md`:** bare paths like `src/lib/tauri-api.ts` or
`src-tauri/src/pty.rs` are relative to **`apps/desktop/`**. Paths starting with `packages/`,
or `docs/` are relative to the repo root.

**Reading documents written before 2026-08-02** (older ADRs, comments): they refer to pre-restructure paths. Translate as you read:

| In old documents | Now |
|---|---|
| `src/…` | `apps/desktop/src/…` |
| `src-tauri/…` | `apps/desktop/src-tauri/…` |
| `scripts/…` | `apps/desktop/scripts/…` |
| `lotus-remote/…` | `packages/host/…` |

Dependency direction is one-way: **desktop → host**, never the reverse. The single build step that
crosses the boundary is `apps/desktop/scripts/build-host-bundle.mjs`, which writes into
`packages/host/dist/`.

## Commands

```bash
# From the repo root — thin pass-through scripts delegate to the right package
bun run tauri:dev        # desktop, native window with hot reload
bun run test             # desktop suite
bun run host:test        # packages/host suite
bun run pocket:test      # apps/pocket suite
bun run pocket:analyze   # apps/pocket analyser, strict mode
bun run pocket:dev       # pocket on the Android emulator, hot reload attached
bun run test:all         # all three suites

# Or work inside a package directly
cd apps/desktop && bun run tauri:dev
cd packages/host && bun run test
cd apps/pocket && flutter test
```

`apps/pocket` has its own [`README.md`](apps/pocket/README.md) covering its layers, its enforced
dependency direction, first-time emulator setup, and the Android-toolchain traps that cost the most
time to work out.

The root `package.json` is pass-through only — it intentionally does **not** use bun/npm workspaces,
because `apps/pocket` is managed by `pub`, so there is no shared dependency graph to optimize. Each
package's own `package.json` stays the source of truth.

> **One-time gotcha after pulling the meta-repo restructure.** Cargo's Tauri build script caches
> absolute paths in `target/`, so a `target/` produced before the move makes `cargo` fail with
> `failed to read plugin permissions: … /src-tauri/target/…: No such file or directory` — note the
> *pre-move* path in the message. Fix once with
> `rm -rf apps/desktop/src-tauri/target/debug/build/{tauri,lotus}-*`. A full `cargo clean` also works
> but costs a complete rebuild.

> **The same trap has a Next.js twin, and it bites later.** Turbopack keys its persisted modules by
> absolute path, so a `.next/` written before the move still points at pre-restructure paths. It stays
> invisible while the cache is warm and surfaces on the first cold compile, as:
>
> ```
> Error: Can't resolve './fonts.css' in '<repo>/src/styles/canvas'
> ```
>
> Note the missing `apps/desktop/` — that directory has not existed since 2026-08-02, and the file it
> is looking for sits beside its importer, so the import itself is correct. Confirmed by finding the
> pre-move path inside `.next/dev/static/chunks/*.css.map` while **zero** cache files mentioned the
> post-move path. Fix once with `rm -rf apps/desktop/.next`.
>
> Diagnosis shortcut for any post-move resolve error: if the path in the message is missing
> `apps/desktop/`, it came from a cache, not from the code.

> **And a third instance of the same class, found 2026-08-28: a NEW `@import` added to an existing
> CSS entry is not picked up.** Adding `@import "./canvas-command-sheet.css";` to
> `src/styles/canvas/index.css` left the served CSS chunk unchanged — and *restarting the app does
> not fix it*, because `tauri:dev` restarts Next but reuses `.next/dev`. The symptom is a component
> that arrives as raw unstyled HTML (a browser-default yellow `<mark>` is the giveaway) while its
> JS is demonstrably fresh, so it reads as a CSS authoring bug rather than a cache one.
>
> Confirm it in two commands instead of guessing:
>
> ```bash
> # 1. Does the SERVED chunk still contain a class you already deleted from source?
> grep -rl "<a-class-you-deleted>" --include="*.css" .next
> # 2. Does the real @import chain actually include the new file? (lightningcss ships with Next)
> bun -e 'import {bundle} from "lightningcss";
>   console.log(bundle({filename:"src/styles/canvas/index.css"}).code.toString().includes("<new-class>"))'
> ```
>
> A stale class in (1) plus `true` in (2) means the source is correct and the cache is lying. Fix
> with `rm -rf apps/desktop/.next`, then restart `tauri:dev`.

### Never run `bun install` at the repo root

Install per package — `bun run install:all` does this, deliberately `cd`-ing into each one. The root
`package.json` is pass-through and has no dependencies of its own, so an install there produces
nothing except a **root lockfile**, and that lockfile is harmful.

Next derives its Turbopack and output-tracing root by walking **ancestor** directories for a lockfile
and taking the highest one it finds — never siblings. A lockfile at the repo root therefore moves
every Next app's inferred root up to the repo root, pulling `apps/pocket/`, `packages/host/` and
`**/src-tauri/target/` into resolve and watch scope. Same failure class as the two cache traps above:
**invisible until a cold compile**.

A `preinstall` guard (`tools/no-root-install.mjs`) refuses it with an explanation, and
`apps/desktop/next.config.ts` pins `turbopack.root` so desktop is safe even if the guard is bypassed.
Both are belt-and-braces on purpose — the repo previously survived this by accident, because
`install:all` happened to `cd`. See `docs/adr/0011-apps-web-isolation-and-turbopack-root.md`.

If you add another Next app, pin its `turbopack.root` too.

### Cargo target-dir hygiene

`tauri:dev` and `tauri:build:exec` both run `clean:rust-temp` first, which reaps orphaned rustc
metadata staging directories (`target/<profile>/deps/rmeta*/`). Those are created when a compile is
killed mid-run — Ctrl-C on `tauri dev`, an HMR restart — and **nothing else ever removes them**:
Cargo has no garbage collector. They are ~255 MB each here, because `lotus_lib` is a large crate.
Left alone they accumulated 41 directories / 9.7 GB in about two months.

The reaper only touches directories older than 60 minutes, so a build running concurrently in
another terminal is never disturbed. It is silent when there is nothing to do.

It also sweeps stale-but-valid cached artifacts — `deps/` files and `incremental/` sessions
untouched for **14 days** — because Cargo keeps every past hash variant forever and the churn here
is weekly: `tauri dev`, `cargo test` and rust-analyzer each hash `lotus_lib` differently. Measured
2026-08-27, two months without a sweep reached **70 GB** (13 variants of `lotus_lib`, 45 k object
files, 18 GB of incremental sessions) against ~19 GB actually in use. `[profile.dev]` is
`debug = "line-tables-only"` for the same reason; flip it locally if you need lldb variables.

```bash
bun run clean:stale                              # the same sweep, on demand (14 days)
LOTUS_RUST_STALE_DAYS=7 bun run clean:stale      # more aggressive
LOTUS_RUST_AUTO_SWEEP_DAYS=0 bun run tauri:dev   # keep everything for this session
cargo clean                                      # everything, full rebuild after
```

The threshold is an env var, not a flag, on purpose: these scripts pass through two layers
(root → `apps/desktop` → node), and a `-- --stale=7` argument arrives alongside the hardcoded
`--stale`, where flag parsing picks the wrong one and silently uses the default. An env var survives
any nesting depth.

> **Never point a worktree's build at this repo's `target/`, found 2026-09-28.** A build run in a
> temporary git worktree (`/private/var/folders/…/T/wt-s06`) with `CARGO_TARGET_DIR` aimed at
> `apps/desktop/src-tauri/target` overwrote `liblotus_automation-*.rlib` with a build of OLDER
> source — the worktree was at HEAD, without uncommitted files. A workspace member at the same
> relative path gets the same artifact hash in both trees, so the files collide, and Cargo judges
> freshness by mtime: the repo's sources were older than that rlib, so it was reused. `tauri:dev`
> then failed on code that is fine in the repo:
>
> ```
> error[E0433]: failed to resolve: could not find `reply_style` in `pr_review`
> error[E0560]: struct `SendRequest` has no field named `close_threads`
> note: function defined here
>    --> /private/var/folders/…/T/wt-s06/apps/desktop/src-tauri/crates/lotus-automation/src/…
> ```
>
> The giveaway is the `note:` path: a definition that lives OUTSIDE the repo. Confirm with
> `grep -c -a wt-s06 target/debug/deps/liblotus_automation-*.rlib` (non-zero = built elsewhere).
> Fix with `cargo clean -p lotus-automation` in `apps/desktop/src-tauri` (removes only that crate's
> artifacts; 11.4 GB here, other crates untouched). A worktree that builds must use its own target
> dir — the default `target/` inside the worktree.

Production bundles, the Windows MSVC / `link.exe` setup, the macOS install shortcut, and the Linux
system deps are in the **`tauri-build` skill** (`.claude/skills/tauri-build/SKILL.md`).

## Architecture Overview

This is a **Tauri 2 desktop app** — a native window wrapping a statically-exported Next.js 16 / React 19 frontend. There is no HTTP server, no WebSocket layer. All backend logic runs in Rust.

The app is a GUI frontend for the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` feature. It:
1. Lets users configure multi-agent teams (lead + specialists) with roles, models, and prompts
2. Persists team/task configs to `~/.claude/` on the local filesystem
3. Spawns `claude` CLI processes as the team lead agent via the Rust backend
4. Streams PTY output back to the frontend via `tauri::ipc::Channel`
5. Provides a full multi-pane terminal workspace with search, WebGL rendering, and workspace tabs

### Tauri IPC Pattern

All frontend→backend calls use `invoke()` from `@tauri-apps/api/core` instead of `fetch()`. The wrapper lives in `src/lib/tauri-api.ts`.

On the Rust side, each `#[tauri::command]` is defined inside `pub mod commands {}` in `lib.rs` (required to avoid the E0255 re-export collision in tauri-macros 2.5.5+ with Rust 1.88+). The actual implementations live in the domain modules (`pty.rs`, `teams.rs`, etc.).

### File-System Integration

All persistence is to `~/.claude/` — no database. `src-tauri/src/paths.rs` is the source of truth for the exact paths.

### PTY Session Management

PTY lifecycle is managed by two layers:

- **`PtySessionController`** (`src/lib/pty-session-controller.ts`) — Class-based manager. Handles connect/abort/cleanup. Reaps orphan sessions from previous renders.
- **`usePtySession`** (`src/hooks/usePtySession.ts`) — React hook wrapping the controller. Provides `PtyHandle` (sessionId, status, write, resize). Calls `ctrl.abort()` on unmount to prevent dangling sessions during HMR.

### Bridge Agent & MCP Integration

The **Bridge** pane (CodeSpace orchestrator cell) wraps Claude CLI as a persistent reasoning engine.

Single flow: user types a prompt → `claude --dangerously-skip-permissions --print --output-format stream-json --verbose [--resume <id>] <prompt>`. Session id is stored per-workspace in `services/bridge/session-store.ts` so follow-ups resume the same conversation. CLI runs in YOLO mode — no per-tool approval prompts. Claude itself decides whether to answer directly, invoke built-in tools (Read/Write/Edit/Bash/Grep/Glob), or invoke Lotus MCP tools (see below).

**MCP sidecar** (`scripts/lotus-mcp-server.mjs`) extends Claude CLI with Lotus-specific tools:
- Registered automatically via `~/.claude.json` → `mcpServers.lotus` on app startup.
- Sidecar is a Bun-runnable stdio MCP server that talks to the running Lotus app via localhost HTTP (port + Bearer secret advertised in `<lotus state dir>/lotus-mcp-ipc.json` — `~/.lotus/lotus-mcp-ipc.json` for release, `~/.lotus-dev/` for dev; Unix perm 0600).
- Rust side: `src-tauri/src/mcp_ipc.rs` (axum server), `src-tauri/src/mcp_config.rs` (file writers), state managed by `McpIpcSharedState`. Fleet snapshot pushed from frontend via `bridge_push_fleet_snapshot` Tauri command; spawn requests round-trip via Tauri event `mcp://spawn-cell` + `bridge_resolve_mcp_request` command.
- Tools live: `lotus_list_fleet`, `lotus_dispatch_to_cell`, `lotus_read_cell_output`, `lotus_spawn_cell`, `lotus_wait_cell_idle`. PTY output ring buffer (64KB/session) in `pty.rs` backs the read/wait tools.

When developing Bridge: remember the sidecar is a **separate process** spawned by Claude CLI (not by Lotus). It re-reads IPC config per tool call so Lotus restart does not require killing it.

### Build Pipeline

- Next.js is configured with `output: "export"` only when `TAURI_ENV_TARGET_TRIPLE` is set — produces a static site in `out/`
- In dev mode (without Tauri), Next.js runs as a normal server (API routes are active via `.server.ts` files)
- Tauri bundles the `out/` directory into the native app binary
- **CSP**: `src-tauri/tauri.conf.json` → `app.security.csp` is enforced only in the release build
  (`tauri dev` loads the dev server directly). Dev sends the same policy as
  `Content-Security-Policy-Report-Only` (`next.config.ts`), so nothing is blocked there but each
  violation is written to `<lotus state dir>/csp-violations.log`. A feature that loads from a new
  origin (CDN, iframe, the loopback API server) must be added to the CSP, or it breaks only in the
  release — check that log after trying it in dev.

### UI Conventions

- No state management library — components call `tauri-api.ts` functions directly
- API routes under `src/app/api/` use `.server.ts` extension so they are excluded from Tauri static export builds

## Agent skills

### Issue tracker

Issues live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: one `GLOSSARY.md` at the root, ADRs under `docs/adr/`. See `docs/agents/domain.md`.
