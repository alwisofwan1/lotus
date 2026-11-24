# Lotus — Desktop Workbench for AI Coding Agents

A native desktop application for running and managing `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` workflows. Built with **Tauri 2** (Rust backend) + **Next.js 16** (static frontend) + **React 19**.

The app provides a full multi-pane terminal IDE for orchestrating Claude Code multi-agent teams — configure teams, launch workflows, and watch agents collaborate in real time.

## What It Does

- Configure multi-agent teams (lead + specialists) with roles, models, and prompts
- Launch teams against a local project directory with a 4-step wizard
- Open interactive PTY terminals in a multi-pane workspace with workspace tabs
- Stream live log output from running agent processes
- In-terminal search (Cmd+F / Ctrl+F) with WebGL-accelerated rendering
- Persist team/task configs to `~/.claude/` on the local filesystem

## Prerequisites

- [Rust toolchain](https://rustup.rs/) (stable, 1.80+), **Windows:** use the default **MSVC** target (`x86_64-pc-windows-msvc`)
- [Tauri CLI v2](https://v2.tauri.app/start/prerequisites/): `cargo install tauri-cli --version "^2"`
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code): `npm install -g @anthropic-ai/claude-code`
- [Bun](https://bun.sh/) or Node.js 20+

### Windows (native) — MSVC + SDK

Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (or full Visual Studio) with:

- **Desktop development with C++** (MSVC, `link.exe`)
- **Windows 10 SDK** or **Windows 11 SDK** (required for `kernel32.lib` and other system libs — without it you may see `LNK1181`)

Also install [WebView2 Evergreen](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) if it is not already present. VS Code alone does **not** provide the C++ toolchain.

**Why a separate script:** Integrated terminals (Cursor, VS Code, plain PowerShell) often do not load the Visual Studio environment, so Rust cannot find `link.exe`. Use the Windows build entry point below instead of calling `tauri build` directly in those shells.

## Installation & Development

```bash
# Install JS dependencies for every package (apps/desktop + packages/host)
bun run install:all

# Start development (opens native desktop window + hot reload)
bun run tauri:dev
```

All root scripts are pass-through — they delegate into the right package. You can equally
`cd apps/desktop` and run the same commands there.

## Build

`package.json` wires production builds as follows:

| Script                     | When to use                                                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run tauri:build`      | **macOS / Linux** — same as `bun run tauri:build:exec` (cleans `out`/`.next/cache`, then `tauri build`).                                                                                                                                                                |
| `bun run tauri:build:win`  | **Windows (recommended)** — runs [`apps/desktop/scripts/tauri-build-windows.ps1`](apps/desktop/scripts/tauri-build-windows.ps1): locates VS/Build Tools via `vswhere`, runs `vcvars64.bat` in one `cmd` session so MSVC and the Windows SDK are on `PATH`/`LIB`, then `bun run tauri:build:exec`. |
| `bun run tauri:build:exec` | Internal step — `rimraf out .next/cache && CI=true tauri build`. Prefer `tauri:build` or `tauri:build:win` from the repo root.                                                                                                                                          |
| `bun run tauri:build:mac`  | macOS convenience — build plus `rsync` of the app bundle to `/Applications/`.                                                                                                                                                                                           |
| `bun run tauri:verify:mac` | macOS verification helper — checks bundle paths, app metadata, Mach-O architecture, `codesign`, and Gatekeeper (`spctl`) status for the built Lotus artifact.                                                                                                           |

```bash
# macOS / Linux
bun run tauri:build

# Windows (from PowerShell or cmd — avoids "link.exe not found" in IDE terminals)
bun run tauri:build:win
```

Output is placed in `apps/desktop/src-tauri/target/release/bundle/`.

### macOS Build and Sharing

For a normal macOS build:

```bash
bun run install:all
bun run tauri:build:mac
```

This produces:

- `apps/desktop/src-tauri/target/release/bundle/macos/Lotus.app`
- `apps/desktop/src-tauri/target/release/bundle/dmg/Lotus_<version>_<arch>.dmg`

To verify the artifact before sharing it:

```bash
bun run tauri:verify:mac
```

The verifier prints:

- bundle metadata from `Info.plist`
- compiled binary architecture
- `codesign` details and verification result
- Gatekeeper assessment for the app and DMG

Internal team sharing is usually fine even if the app is unsigned, but there are two practical limits:

- macOS may warn that Apple cannot verify the app, so recipients may need `Right click > Open` or `System Settings > Privacy & Security > Open Anyway`.
- A build produced on Apple Silicon is usually `arm64` and may not run on Intel Macs.

This repository currently builds macOS artifacts but does not set up Apple Developer signing or notarization. For wider distribution outside a trusted team, add codesigning and notarization before shipping the DMG.

### Troubleshooting: "Lotus is damaged and can't be opened"

When the `.dmg` is shared via **Slack, email, or a browser download**, macOS attaches a quarantine flag to the file. Combined with a missing notarization, Gatekeeper shows:

> _"Lotus" is damaged and can't be opened. You should move it to the Trash._

The app is not actually damaged — the quarantine attribute is the cause. Remove it with:

```bash
xattr -dr com.apple.quarantine /Applications/Lotus.app
```

After running that command, double-click the app normally and it will open.

## Project Structure

Lotus is a **meta-repository** — nothing application-level lives at the root:

```
lotus/
├── apps/
│   ├── desktop/                      # Tauri 2 + Next.js workbench (detailed below)
│   └── pocket/                       # Lotus Pocket — Flutter mobile client
├── packages/
│   └── host/                         # Host layer: PTY, agent runners, Standalone Host
├── contract/                         # Cross-app API spec, consumed by both apps
├── tools/remotion-bar-chart/
├── docs/  plans/  research/          # Cross-app, stay at the root
└── package.json                      # Pass-through scripts only
```

Dependency direction is one-way: **desktop → host**, never the reverse.

### Inside `apps/desktop/`

All paths below are relative to `apps/desktop/`.

```
apps/desktop/
├── src/                              # React frontend (Next.js 16, static export)
│   ├── app/                          # App Router pages
│   │   ├── terminal/page.tsx         # Multi-workspace terminal viewer (main UI)
│   │   ├── teams/                    # Team management pages
│   │   ├── logs/page.tsx             # Agent log viewer
│   │   ├── appearance/page.tsx       # Theme switcher
│   │   ├── settings/page.tsx         # Global settings
│   │   └── api/                      # REST fallbacks for browser dev mode
│   ├── components/
│   │   ├── LaunchModal.tsx           # 4-step launch wizard
│   │   ├── TerminalViewer.tsx        # Log poller / renderer
│   │   ├── InteractiveTerminal.tsx   # xterm.js terminal with addon support
│   │   └── terminal/                 # Terminal workspace components
│   │       ├── TerminalCell.tsx      # Single terminal pane
│   │       ├── TerminalSearchBar.tsx # In-terminal search UI
│   │       ├── TerminalGrid.tsx      # Multi-pane grid layout
│   │       ├── AgentFleetView.tsx    # Agent status cards
│   │       ├── ConfigureLayoutView.tsx
│   │       └── WorkspaceTabBar.tsx
│   ├── hooks/
│   │   └── usePtySession.ts          # React hook for PTY session lifecycle
│   ├── contexts/
│   │   └── ThemeContext.tsx          # Theme switching context
│   └── lib/
│       ├── tauri-api.ts              # IPC wrapper — all invoke() calls live here
│       ├── pty-session-controller.ts # Class-based PTY lifecycle manager
│       ├── terminal-addons.ts        # xterm addon loader (WebGL, Search, etc.)
│       ├── themes.ts                 # AppTheme definitions
│       ├── mock-data.ts              # Static templates and mock data
│       └── types.ts                  # Shared TypeScript types
├── src-tauri/                        # Rust backend
│   ├── src/
│   │   ├── lib.rs                    # App setup + command registration
│   │   ├── main.rs                   # Entry point
│   │   ├── pty.rs                    # PTY session management
│   │   ├── teams.rs / tasks.rs       # Config CRUD
│   │   ├── launch.rs                 # Claude CLI spawning
│   │   ├── logs.rs / processes.rs    # Log reading + process tracking
│   │   └── fs_browse.rs / settings.rs
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/                 # Tauri permission model
├── scripts/
│   ├── tauri-build-windows.ps1      # Windows: vcvars64 + tauri:build:exec (MSVC/SDK env)
│   └── install-linux-tauri-deps.sh  # Linux/WSL: apt packages for Tauri
├── next.config.ts                    # Next.js config (conditional static export)
└── package.json
```

## How It Works

1. The frontend is built as a **static export** (`next build`) when `TAURI_ENV_TARGET_TRIPLE` is set, and served by the Tauri webview — no HTTP server involved.
2. In browser dev mode (without Tauri), the app runs as a normal Next.js server with REST API routes (`.server.ts` files).
3. All backend logic lives in the **Rust layer** under `apps/desktop/src-tauri/src/`, exposed as Tauri commands.
4. The frontend calls `invoke("command_name", args)` via `apps/desktop/src/lib/tauri-api.ts` instead of `fetch()`.
5. PTY terminal output is streamed from the Rust PTY layer to the frontend via `tauri::ipc::Channel`, managed by `PtySessionController` and the `usePtySession` hook.
6. Agent processes (Claude CLI) are spawned by the Rust backend with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

## Key Tauri Commands

| Command                                       | Description                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `spawn_claude`                                | Spawn a Claude CLI agent process, write team/task config to `~/.claude/` |
| `read_log_chunk`                              | Read new bytes from a team's log file since a given offset               |
| `list_logs`                                   | List log files in `~/.claude/agent-teams-logs/`                          |
| `create_session`                              | Open a PTY shell session, stream output via IPC Channel                  |
| `write_to_session`                            | Send input to a PTY session                                              |
| `resize_session`                              | Resize PTY dimensions                                                    |
| `kill_session`                                | Terminate a PTY session                                                  |
| `list_sessions`                               | List active PTY sessions                                                 |
| `list_teams`                                  | Read team configs from `~/.claude/teams/`                                |
| `get_team`                                    | Read a single team config                                                |
| `create_team` / `update_team` / `delete_team` | Manage team configs                                                      |
| `list_tasks` / `create_task`                  | Manage task files for a team                                             |
| `get_homedir`                                 | Return the user's home directory path                                    |
| `list_projects`                               | Read Claude Code project history from `~/.claude/projects/`              |
| `list_dir_entries`                            | Browse local filesystem directories                                      |
| `get_settings` / `save_settings`              | Read/write `~/.claude/settings.json`                                     |
| `list_processes`                              | Return alive PIDs from `~/.claude/agent-teams-procs.json`                |
| `kill_process`                                | Kill a running agent process by PID                                      |

## Roadmap

#### v0.x — Near-term

- [ ] **Session persistence** — restore workspace layouts, tabs, and grid config across restarts
- [x] **Structured agent output** — parse `stream-json` events into formatted cards
- [ ] **Desktop notifications** — native toasts when an agent finishes or errors
- [x] **Workspace presets** — save and recall named grid layouts (e.g. "3-agent review")
- [ ] **Context-aware multi-window menu** — let the native app menu open focused windows for surfaces like CodeSpace, CodeChat, Logs, and Settings so multi-window flows feel intentional instead of generic
- [ ] **Draggable workspace tabs** — support drag-to-reorder and drag-driven workspace restructuring so tab management is faster and the terminal UX feels more fluid
- [x] **More terminal themes** — additional color schemes in the appearance page
- [ ] **Multi Agenst on multi workspace in the same time** — support multiple agents on multiple workspaces in the same time in CodeChat Playground.
- [x] **Terminal close confirmation** — show a confirmation dialog when closing a terminal session

#### v1.x — Mid-term

- [ ] **Agent communication graph** — real-time visualization of lead ↔ specialist message flow
- [ ] **Diff viewer pane** — inline file changes produced by agents, no need to leave the app
- [ ] **File browser** — side-panel directory tree scoped to the active project
- [ ] **Token & cost tracking** — per-session usage display from `stream-json` metadata
- [x] **Multi-project support** — open multiple project directories in separate workspace tabs
- [ ] **Auto-updater** — in-app update check and one-click install via Tauri updater
- [x] **Agents Chat** — conversational chat interface with agents, similar to Claude Desktop, with GUI selectors for active **Skills** and **Workflows** per session so users can configure agent behavior without touching config files
- [ ] **Plugin system** — import community plugins or build your own (inspired by [Paperclip](https://github.com/paperclipai/paperclip)); plugins can expose new tools, MCP servers, or UI panels; managed via an in-app plugin manager with install/enable/disable/remove controls

#### v2.x — Long-term

- [ ] **Plugin marketplace** — discover and publish plugins; one-click install from a curated registry, similar to VS Code extensions
- [ ] **Team config marketplace** — share and import team configurations (roles, models, prompts)
- [ ] **Cloud sync** — sync `~/.claude/teams/` and installed plugins across machines via an external store
- [ ] **Cross-platform releases** — CI pipelines and bundles for Windows (MSI) and Linux (AppImage)

## License

MIT — see [`LICENSE`](LICENSE). Bundled third-party code and fonts keep their own licenses (for example `apps/desktop/scripts/chat-bridge/LICENSE-bb`, `apps/desktop/public/fonts/Excalifont-NOTICE.txt`).

Contributions: [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports: [`SECURITY.md`](SECURITY.md).
