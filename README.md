# Lotus

A native desktop workbench for AI coding agents, for macOS (Apple Silicon) and Windows (x64).
Agents, terminals, notes and a browser share one workspace; agents hand work to each other and
stop when they need you. Built with **Tauri 2** (Rust) and **Next.js 16 / React 19**.

**Status:** beta. Website and changelog: <https://lotus-web.pages.dev>.

## Download

- macOS (Apple Silicon): [Lotus-macos-arm64.dmg](https://github.com/alwisofwan1/lotus/releases/latest/download/Lotus-macos-arm64.dmg)
- Windows (x64): [Lotus-windows-x64-setup.exe](https://github.com/alwisofwan1/lotus/releases/latest/download/Lotus-windows-x64-setup.exe)
- All versions: [Releases](https://github.com/alwisofwan1/lotus/releases)

Lotus updates itself after the first install. Bring the agent CLIs you already use: Claude,
Codex, Gemini, OpenCode, Cursor, Droid, Copilot, Antigravity, Grok, Kimi, Pi, or your own.

The macOS build is self-signed, not notarized. If macOS says _"Lotus" is damaged and can't be
opened_, the download quarantine flag is the cause, not the app. Remove it:

```bash
xattr -dr com.apple.quarantine /Applications/Lotus.app
```

## What it does

- **Canvas** — agents, terminals, notes and browser nodes on one board. Select agents, a critic
  and a human gate, then run the graph; the gate waits for your Approve or Reject.
- **Code panes** — a multi-pane terminal workspace that runs any of the agent CLIs above, with
  search, workspace tabs and an editor (⌘P, Source control, diff on agent changes).
- **Chat** — a conversation view over Claude, Codex and other runners, per project.
- **Automations** — trigger → action → output, for example "review a PR when someone asks in
  Slack" or "every weekday at 9".
- **Connectors** — Slack, GitHub, Notion and Google, used by Automations and Tasks.
- **Tasks** — one task list across Lotus, Notion and GitHub.
- **Voice** — dictation and a spoken or chimed alert when an agent finishes.
- **Remote hosts** — run agents on another machine over SSH; Lotus installs and updates the host.
- **Lotus Pocket** — a mobile client, in development, that attaches to running sessions and answers agent
  permission prompts ([`apps/pocket`](apps/pocket/README.md)).
- **MCP tools** — agents inside Lotus can list, message and spawn other panes, and read notes
  and tasks.

## Repository layout

```
apps/desktop/    Tauri 2 + Next.js desktop app (src/, src-tauri/, scripts/)
apps/pocket/     Lotus Pocket, Flutter mobile client
apps/web/        Website and changelog (Astro, Cloudflare Pages)
packages/host/   Host layer: PTY, agent runners, Standalone Host for remote machines
contract/        Cross-app API spec shared by desktop and pocket
brand/           Logo and app-icon masters
docs/adr/        Architecture decision records
tools/           Small standalone tools
```

Dependency direction is one-way: **desktop → host**. More detail for contributors is in
[`CLAUDE.md`](CLAUDE.md) (architecture, build traps) and [`GLOSSARY.md`](GLOSSARY.md).

## Development

Prerequisites:

- [Rust](https://rustup.rs/) stable. **Windows:** the default MSVC target, plus
  [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with
  *Desktop development with C++* and a Windows 10/11 SDK, and
  [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
- [Bun](https://bun.sh/).
- At least one agent CLI, for example
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code).
- Linux/WSL system packages: `bun run setup:linux`.

```bash
git config core.hooksPath .githooks   # once per clone: pre-commit checks
bun run install:all                   # install each package (never `bun install` at the root)
bun run tauri:dev                     # desktop app with hot reload
```

Tests:

```bash
bun run test        # desktop
bun run host:test   # packages/host
bun run pocket:test # apps/pocket
bun run web:test    # apps/web
bun run test:all    # desktop, host and pocket
```

## Build and release

```bash
bun run tauri:build       # macOS / Linux
bun run tauri:build:win   # Windows; loads the MSVC environment first
bun run tauri:build:mac   # macOS, then copies Lotus.app to /Applications
```

Output goes to `apps/desktop/src-tauri/target/release/bundle/`.

A release is `bun run release:mac <x.y.z> --publish` from `apps/desktop`. It builds and signs
the macOS app and the Linux host, publishes them to this repo's Releases with the update feed,
and starts the Windows build in GitHub Actions. Release notes come from
`apps/web/src/releases/<x.y.z>.md`, which is also the website changelog entry.

## License

MIT — see [`LICENSE`](LICENSE). Bundled third-party code and fonts keep their own licenses (for
example `apps/desktop/scripts/chat-bridge/LICENSE-bb`,
`apps/desktop/public/fonts/Excalifont-NOTICE.txt`).

Contributions: [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports: [`SECURITY.md`](SECURITY.md).
