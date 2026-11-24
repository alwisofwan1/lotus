# Repository Guidelines

## Project Structure & Module Organization
Lotus is a **meta-repository**: `apps/desktop` (Tauri 2 + Next.js workbench), `apps/pocket` (Flutter mobile client, planned), `packages/host` (host layer — PTY, agent runners, Standalone Host; formerly `lotus-remote/`), `contract/` (cross-app API spec, planned), and `tools/`. `docs/`, `plans/`, and `research/` are cross-app and stay at the root. Dependency direction is one-way: desktop → host, never the reverse.

**Path convention below:** bare paths are relative to `apps/desktop/`. Entries in the dated log at the end of this file predate 2026-08-02 and use pre-restructure paths — they are historical records, deliberately not rewritten; translate `src/…` → `apps/desktop/src/…`, `src-tauri/…` → `apps/desktop/src-tauri/…`, `scripts/…` → `apps/desktop/scripts/…`, `lotus-remote/…` → `packages/host/…`.

Within `apps/desktop`: `src/app` contains Next.js App Router pages and browser fallback API routes. Reusable UI lives in `src/components`, terminal-specific UI in `src/components/terminal`, shared logic in `src/lib`, and hooks/test setup in `src/hooks` and `src/test`. The native backend lives in `src-tauri/src` with domain modules such as `pty.rs`, `launch.rs`, `teams.rs`, and `settings.rs`. Static assets are under `public/`.

## Build, Test, and Development Commands
Use Bun for JavaScript tasks:

- `bun install` installs frontend dependencies.
- `bun run tauri:dev` starts the desktop app with Next.js hot reload.
- `bun run tauri:build` runs `tauri:build:exec` (production Tauri bundle). Use this on **macOS/Linux**.
- `bun run tauri:build:win` runs `scripts/tauri-build-windows.ps1`, which loads MSVC + Windows SDK via `vcvars64.bat`, then `tauri:build:exec`. Use this on **native Windows** (including Cursor’s terminal) so `link.exe` and `kernel32.lib` resolve; plain `tauri:build` in an IDE shell often fails with `link.exe not found`.
- `bun run tauri:build:exec` is the inner step (`rimraf out .next/cache && CI=true tauri build`). Prefer the `tauri:build` or `tauri:build:win` entry points from the repo root.
- `bun run tauri:build:mac` builds the macOS `.app` via `scripts/tauri-build-macos.mjs`, creates the DMG with a simple `hdiutil` staging flow instead of Tauri's generated `bundle_dmg.sh`, copies the `.app` to `/Applications/`, then verifies the artifacts.
- `bun run setup:linux` installs apt packages needed for Tauri on Debian/Ubuntu/WSL (`scripts/install-linux-tauri-deps.sh`).
- `bun run build` builds the Next.js frontend.
- `bun run lint` runs ESLint with the Next.js and TypeScript rules.
- `bun run test` runs the Vitest suite in `jsdom`.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` runs Rust tests when backend code changes.
- `bun run host:test` runs the `packages/host` suite; `bun run test:all` runs desktop + host.

**Windows prerequisites:** Visual Studio Build Tools (or VS) with **Desktop development with C++** and a **Windows 10/11 SDK** workload, plus WebView2. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Coding Style & Naming Conventions
TypeScript uses the repo’s ESLint config (`eslint.config.mjs`) and follows the existing style: double quotes, semicolons, and named exports for shared modules. Use `PascalCase` for React components (`AppShell.tsx`), `camelCase` for hooks/utilities (`usePtySession.ts`), and kebab-free route folders under `src/app`. Keep Tauri IPC wrappers in `src/lib/tauri-api.ts`; avoid calling `invoke()` directly from components. Rust modules stay small and domain-focused, with snake_case filenames and `#[tauri::command]` entrypoints registered in `src-tauri/src/lib.rs`.

## Testing Guidelines
Frontend tests use Vitest, Testing Library, and `src/test/setup.tsx`. Co-locate tests with the code they cover using `*.test.ts` or `*.test.tsx`, for example `src/components/Sidebar.test.tsx` or `src/lib/agent-parsers/__tests__/raw-parser.test.ts`. Add or update tests for parsing, terminal state, and UI flows when behavior changes.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commits: `feat:`, `fix:`, and `refactor:`. Keep subjects imperative and concise, for example `feat: add CodeChat menu`. PRs should explain the user-visible change, note any Tauri or filesystem side effects, link the relevant issue or plan, and include screenshots for UI changes.

## Architecture Notes
This app is a Tauri desktop shell over a Next.js frontend. Persisted state is stored in `~/.claude/`, and backend capabilities are exposed through Rust commands rather than HTTP. When adding features, decide first whether the change belongs in the React UI, the shared TypeScript bridge layer, or the Rust backend.

## Change Log

### 2026-08-09 — PTY confirmed-write receipt seam
Interactive PTY typing remains fire-and-forget, while receipt-sensitive submission flows use `PtySessionController.writeConfirmed()` through `usePtySession` or the terminal-session-registry confirmed-write compatibility seam to await the native `write_to_session` acknowledgement. CodeCanvas Live Agent paste/Enter queues must resolve ready-agent replies only after both native writes settle and reject outstanding receipts on write failure or disposal, so voice delivery never reports `written` from a renderer-only enqueue. NL-bar submissions to plain Canvas Terminals must encode one bracketed-paste-safe submit, require a live/detached pane, await that receipt, and report timeouts as unknown rather than failed.

### 2026-07-24 — PTY process-tree and Live Agent renderer energy boundary
Explicit PTY close/quit paths must finish terminating the session-owned process tree before reporting success, while project switches remain detach-only so background projects continue running. CodeCanvas Live Agent renderer output is frame-coalesced independently from immediate readiness/activity parsing so PTY bursts cannot drive hundreds of xterm DOM writes per second.

### 2026-06-30 — CodeCanvas collaboration overlay trigger contract
CodeCanvas collaboration ledger UI must stay off for ordinary `/canvas` and plain workflow edit/run routes unless an explicit collaboration launch context is present. Swarm Task "Run with Workflow" routes to `/canvas?run=<workflow>&collab=swarm-task&task=<taskId>&workspace=<workspaceId>`; Swarm Workflow run routes to `/canvas?run=<workflow>&collab=swarm-workflow`. The Canvas overlay is a lightweight projection for headless AgentNode coordination and must remain collapsible so the canvas stays clean by default. Task-triggered overlays fetch the workspace-scoped Bridge/Swarm task and render real task title, status, priority, assignees, and latest feedback timeline events; missing/deleted tasks must degrade visibly without breaking the canvas. Participant projection is pure CodeCanvas logic: task assignees missing from the canvas surface as `not-spawned`, matched live AgentNodes show running/queued/done/needs-attention state, extra Canvas agents remain visible as `canvas-agent`, focus affordances are shown only when a participant is backed by a real Canvas `nodeId`, and CodeCanvas must not import Swarm modules directly. The overlay may offer a "Spawn missing agents" action that creates headless Canvas AgentNodes from missing assignees through the existing Canvas command surface, submits an initial task brief, records a durable assignee-to-node ledger mapping so renamed AgentNodes still resolve for focus/status, syncs ledger lifecycle state from participant projections (`assigned`, `running`, `done`, `blocked`), records durable project-backed mailbox handoff messages/evidence/blocker records, supports manual and MCP-mediated evidence/blocker recording from participant details or agent tools, lets MCP tools write directly to project-backed records when projectId/runId are supplied, persists collaboration run/task context for native MCP reads after Canvas closes, exposes copyable projectId/runId MCP context in the opt-in overlay, refreshes direct MCP task context from the native Bridge task store when possible, emits/listens for native collaboration-record update events so open Canvas overlays refresh after direct MCP writes, ingests Swarm task feedback into mailbox evidence/blocker messages idempotently, lets mailbox evidence/blockers influence participant state, and can show lightweight ledger/mailbox/storage indicators such as "Brief sent"/ledger state/recent evidence/Updated by MCP; collaboration services only build pure AgentDefinition/brief/ledger/mailbox/context/MCP projections and never mutate the graph directly. Collaboration overlays may route back to Swarm via `/swarm?surface=tasks&task=<id>` or `/swarm?surface=workflows&workflow=<id>`; the Swarm shell must honor non-terminal `surface` query params, and Tasks/Workflows surfaces must use their respective id query params to open the matching detail drawer so Canvas-to-Swarm returns land on the intended context.

### 2026-06-29 — CodeSpace runtime hardening worktree baseline
CodeSpace runtime hardening work uses the `harden/codespace-runtime-dev-isolation` worktree from `origin/main`. `bun run tauri:dev` must launch with `src-tauri/tauri.dev.conf.json`, giving Lotus Dev a separate desktop identity (`Lotus Dev`, `com.lotus.desktop.dev`) while keeping release as `Lotus`, `com.lotus.desktop`. Terminal V2 inactive panes must not create owned native xterm renderers or start/reattach sessions from renderer lifecycle; renderer/session work begins when the pane becomes active. MCP keeper removes stale other-profile entries when release/dev discovery is missing or points to a dead PID, while preserving live other-profile discovery; Bridge MCP health exposes the active profile key, classifies discovery as missing, stale-pid, stale-port, responsive, or other-profile-live, reports live duplicate release/dev profiles as an actionable degraded warning, can copy compact support diagnostics without secrets/telemetry/command lines/process details, and can run safe stale-profile cleanup that removes only missing/dead-discovery profile files/config without killing processes. Claude/Codex MCP config merges remain idempotent and preserve the other release/dev profile entry. CodeSpace now has a Terminal V2 workspace renderer visibility syncer that applies active-workspace renderer visibility centrally, releases renderer panes when the route is inactive, and ignores non-terminal cells. Terminal V2 runtime diagnostics snapshots are opt-in and redacted by construction, exposing renderer state, session counts/statuses/by-workspace, known pane count, and renderer/input/resize counters without secrets or process command lines; copyable support payloads hash pane/workspace IDs and keep only compact counts/statuses/counters.

### 2026-06-23 — CodeCanvas Browser annotation routing
Paired CodeCanvas BrowserNode annotation captures must route to their wired Canvas Terminal runtime pane, using `parentTerminalId` for the native WebView identity and injected `parentRuntimePaneId` for terminal writes when project-scoped Canvas runtimes differ from node IDs. Browser annotation payloads are parsed through the shared browser-annotation contract, formatted as terminal conversation context, submitted via bracketed-paste-safe terminal text encoding, and visual-attachment follow-up payloads are ignored to avoid duplicate terminal submissions. If the terminal runtime is not yet writable, delivery must subscribe to terminal status and queue until live/detached or fail visibly on exit/timeout. Canvas browser annotation full-payload emits must use `emit_canvas_browser_annotation`; selected image attachments with data URLs are persisted into an OS temp `lotus-canvas-browser-annotation-*` directory. Native Canvas annotation delivery is API-first: the annotation is stored in `CanvasBrowserAnnotationStore`, emitted to the frontend, and best-effort writes a pull instruction directly to the PTY matching `AGENT_CANVAS_TERMINAL_ID`; BrowserNode UI must not own terminal writes. Agents can always pull latest annotation via `$AGENT_CANVAS_API/api/browser/annotation/latest?terminalId=$AGENT_CANVAS_TERMINAL_ID`, while metadata-only attachment navigation follow-ups are ignored in frontend routing to avoid duplicate submissions. Standalone BrowserNodes may still capture/store latest annotations but must not require a terminal write.

### 2026-06-23 — Model catalog projection contract
TypeScript model surfaces must source built-in fallback model options from `src/config/models/catalog.ts` through `src/config/models/presets.ts` projections instead of hardcoding provider lists in feature modules. CodeChat agents, Smart Convert, and the TypeScript model registry defaults use these projections; Smart Convert additionally runs best-effort `discoverCodeChatAgentModels` runtime discovery so CLI/config-discovered models can replace fallback options without a code update. Rust mirrors in `src-tauri/src/model_registry.rs` and `src-tauri/src/codechat_provider.rs` must be updated with the same built-in fallback model list when the catalog changes. Persisted model registries must reconcile built-in providers on load so stale bundled Codex models such as `o3`/`o4-mini` are removed while user-added custom models remain preserved.

### 2026-06-23 — CodeCanvas Smart Convert provider hardening
Smart Convert note-to-task analysis now supports selectable Claude and Codex provider adapters through the existing `smart_convert_note` IPC command. Smart Convert model options must be sourced from the CodeChat agent catalog projections plus runtime model discovery; Codex adds a first `CLI default` option and must not read from stale default model registry fallbacks. The frontend parser must extract JSON from fenced/prefaced model replies, normalize malformed fields into a safe editable draft, and ignore stale async conversions when users re-roll or switch provider. Provider/model selectors must remain usable while a conversion is generating so users can escape a stuck provider; switching provider/model cancels the visible pending request and re-enables Re-roll. The native command must reject empty notes, cap large note prompts, run provider CLIs from an isolated OS temp directory (never the app/repo cwd), keep Codex read-only/ephemeral with ignored repo rules, apply a timeout, kill provider processes on timeout/drop, and keep provider-specific CLI failures actionable.

### 2026-06-23 — CodeCanvas NoteNode spawn and drag contract
New and hydrated CodeCanvas note nodes must carry explicit ReactFlow `draggable: true` plus a `dragHandle` for `.canvas-node-header, .canvas-node-glyph`. The note editor/body remains `nodrag nowheel`, so notes drag from the header in full-detail mode and from the glyph at collapsed LOD without letting Tiptap/editor pointer handling block node movement. Sidebar Add Note buttons must call `onAddNote()` through a wrapper, never pass the click event into `addNoteNode(at?, content?)`; `addNoteNode` must defensively ignore event-like objects as spawn coordinates to avoid corrupting ReactFlow's internal node position until reload.

### 2026-06-21 — CodeSpace Workbench render-phase update guard
Workbench tab/dirty propagation must keep parent `onCellChange` calls outside `setTabs` functional updaters. Right-panel Workbench state updates can reach `CodeSpacePage.setWorkspaces()`, so calling them from a tabs updater may run during Workbench render and trigger React's cross-component render-phase update warning.

### 2026-06-21 — Terminal search live query behavior
Terminal search follows the Terax xterm SearchAddon pattern: live query changes run `findNext` with `incremental: true`, Enter/next/previous navigation runs without incremental, and empty initial search mount does not clear decorations. Xterm search decorations must use background-only match and active-match colors; border-outline decorations caused large floating rectangles in Tauri and should not be reintroduced. If SearchAddon reports a selection, Lotus reselects/refreshes that range to force a Tauri repaint without advancing the match and without requiring `scrollToLine` on hidden/disposed renderers; if it does not produce a matching selection, Lotus falls back to active-buffer scanning plus `terminal.select()` so Claude/TUI output remains searchable. Terminal V2 pooled xterm slots own SearchAddon-backed search APIs, and `TerminalV2Runtime.createPaneSearchApi()` routes search to the currently leased visible renderer before falling back to native/legacy search.

### 2026-06-22 — Terminal V2 pooled renderer theme parity
Terminal V2 default pooled xterm renderers now include a CodeSpace terminal theme derived from the active `--cs-terminal-bg` CSS variable plus the native-owned xterm palette, so pooled slots do not render with xterm's unthemed defaults.

### 2026-06-22 — Terminal V2 pooled renderer font-size parity
Terminal V2 app-level pooled renderer installation now reads the CodeSpace terminal font-size setting and passes it into the default pooled xterm renderer factory. Settings changes reinstall pooled slots with the normalized font size so visible pooled renderers match native/legacy terminal sizing.

### 2026-06-22 — Terminal V2 pooled renderer clipboard addon parity
Terminal V2 default pooled xterm renderers now load and dispose `@xterm/addon-clipboard` through the constructor-injected pooled renderer factory, keeping copy/paste addon behavior owned by the visible pooled renderer instead of relying on native/legacy fallback.

### 2026-06-22 — Terminal V2 pooled renderer focus and custom-key parity
Terminal V2 pooled xterm slots expose focus through `TerminalV2Runtime.focusPaneRenderer()`, and `InteractiveTerminalV2` imperative focus now prefers the currently leased visible renderer before native/legacy fallback. Pooled xterm custom-key handlers bubble pane-local events back to `InteractiveTerminalV2`, which forwards them through the existing `onTerminalCustomKey` shortcut seam and returns the callback result to xterm so layout shortcuts remain single-handled.

### 2026-06-22 — Terminal V2 pooled renderer inline suggestion anchoring
Terminal V2 pooled xterm slots expose their helper textarea, `TerminalV2Runtime.getPaneRendererHelperTextarea()` resolves it from the currently leased visible renderer, and `InteractiveTerminalV2` anchors inline suggestion overlays from that visible helper textarea before falling back to native/legacy runtime helpers.

### 2026-06-22 — Terminal V2 pooled renderer link context menus
Terminal V2 pooled xterm renderers detect terminal links through the shared terminal link parser and dispatch pane-local pooled link context-menu events that `InteractiveTerminalV2` handles with the existing Open/Copy menu. This keeps link context menus attached to the visible pooled renderer instead of relying only on native/legacy xterm slots.

### 2026-06-21 — Terminal file-drop Tauri unlisten guard
Tauri drag/drop listener cleanup is best-effort: unlisten calls are deduped and deferred through a promise boundary because the injected Tauri user-script listener registry can race during React cleanup/HMR and throw `listeners[eventId].handlerId`. This cleanup must never crash CodeSpace terminal surfaces.

### 2026-06-22 — Terminal V2 Cmd+W active-pane close
Terminal V2 dynamic layout maps plain `Cmd+W` to close the active terminal pane through the shared layout-key resolver, root capture, and xterm custom-key path. The handler closes the active V2 pane rather than the stale focused cell or Tauri window, uses the one-shot shortcut guard, and still leaves editable non-terminal targets ignored where appropriate. The native Tauri app menu must not bind Close Window to `Cmd+W`; `Cmd+W` is pane-level terminal UX, while `Cmd+Q` remains the app quit path that may show running-session shutdown confirmation.

### 2026-06-22 — Terminal V2 Ghostty-style split shortcuts
Terminal V2 dynamic layout now maps `Cmd+D` to split the active terminal pane right and `Cmd+Shift+D` to split it down, matching the Ghostty/iTerm-style macOS muscle memory. Split shortcuts route through the same layout root capture and xterm custom-key seam as focus shortcuts and use the one-shot guard; `Ctrl+D` remains terminal EOF and must not be intercepted.

### 2026-06-21 — Terminal V2 layout shortcut dedupe
Terminal V2 dynamic-layout focus shortcuts now use a one-shot guard so the same native keyboard event handled by both layout root capture and xterm custom-key paths cannot advance focus twice and skip panes. Nested split focus also uses visual cycle order plus nearest row/column-overlap scoring for spatial movement so horizontal focus prefers adjacent panes over farther panes in sibling split groups.

### 2026-06-22 — Terminal V2 production native runtime default
Terminal V2 local panes now request the approved all-environments native runtime rollout mode, so production and non-production local panes default to `useTerminalV2NativeRuntime`. `localStorage['lotus:terminal-v2-native-runtime']='0'` remains the emergency bridge-runtime fallback through the explicitly named `useTerminalV2LegacyBridgeFallbackRuntime` seam. The legacy terminal UI fallback surfaces are now explicitly named `LegacyTerminalCell`, `LegacyInteractiveTerminal`, `LegacyTerminalGrid`, and `LegacyGridTerminalCellRenderer`; `TerminalGrid` and `TerminalCell` adapters have been removed, the old `InteractiveTerminal` compatibility shim has been removed, and the temporary `useTerminalRuntime.ts` compatibility shim has been deleted while the hooks barrel keeps a direct alias to `useLegacyTerminalRuntime` for backwards compatibility. Native runtime manual QA and legacy deletion-readiness gates are complete for the default local Terminal V2 ownership cutover; remaining file deletion must follow `terminal-v2-legacy-file-deletion-map.ts`, preserve named Canvas/emergency fallback seams, and treat historical SSH paths as product-hardening prune candidates rather than preservation blockers. The default `PtySessionController` and Bridge headless sessions must not route CodeSpace terminal sessions through SSH PTY creation; the native `create_session_ssh` command and TypeScript `pty-ssh` wrapper have been removed. Terminal UI/runtime code must ignore historical SSH metadata by not showing SSH chrome/error banners, not using SSH output-tail processing, and not setting SSH file-drop location metadata unless a future active product surface reintroduces a dedicated adapter.

### 2026-06-22 — Bridge local natural dispatch before planner
Bridge free-text submissions must run `executeBridgeSubmitRoute` before falling through to the headless planner. Natural local orchestration prompts such as “List fleet, pick the live shell/native terminal pane…, dispatch `echo bridge-ok` …” should dispatch through the in-app CellBus/V2 adapter, not through planner MCP/IPC, so desktop-local dispatch QA does not fail with `Lotus IPC unavailable`.

### 2026-06-22 — Terminal V2 direct-pane file-drop target parity
Terminal V2 direct terminal bodies now carry the shared `data-terminal-file-drop-*` target metadata so native file-drop hit testing resolves V2 panes like legacy terminal bodies. Local POSIX file drops insert escaped paths without wrapping them in single quotes, and the shared file-drop hook has regression coverage that a local dropped file path focuses the resolved pane and writes the escaped path exactly once.

### 2026-06-22 — Terminal V2 native lifecycle detach seam
Native Terminal V2 renderer cleanup now detaches pane output from the disposed UI handler without aborting the PTY. Workspace hide/show and route unmount flows should reattach through `TerminalV2SessionStarter` instead of leaking hidden output into disposed schedulers or killing sessions.

### 2026-06-22 — Terminal V2 plain shell activity badge fallback
Native Terminal V2 shell input now forwards submitted-command hints to the shared activity registry. Silent plain-shell commands without OSC 133, such as `sleep 2 && echo done`, remain running beyond the keystroke debounce until a prompt/ready footer returns or a safety cap expires; agent panes still use the explicit working/standby footer path.

### 2026-06-21 — Terminal V2 Pi/Codex activity badge repaint handling
Native Terminal V2 activity tracking now treats Pi/OpenAI Codex repaint chunks that contain response content plus an idle footer as an active agent turn, then settles back to idle after the quiet window. Pure standby-footer repaints still remain idle, so Claude/Codex status bars do not keep panes running forever.

### 2026-06-20 — Terminal V2 native resize smoothing
Native Terminal V2 layout now publishes explicit live-resize state from split dragging into the direct terminal body. Native panes suppress xterm `fit()` and PTY resize while dragging, then perform one commit fit/PTY resize when the drag settles; ResizeObserver changes outside live drag still coalesce before the debounced PTY resize path. This avoids redrawing Claude Code-style TUIs on every panel drag pixel and keeps pane resize closer to Ghostty-style stable rendering.

### 2026-06-20 — Terminal V2 native exit visibility
Native Terminal V2 output handling now flushes visible exit output before status/session cleanup and writes a dim `[session exited N]` marker when exit output is otherwise empty, preventing exited panes from looking blank after local shell QA. User-reported macOS Tauri dev retest passed `local-shell-launch`: `pwd`, `echo lotus-native-ok`, and `exit` output remained visible with `[Session ended:0]` instead of blanking.

### 2026-06-19 — Terminal V2 native loop hardening
`PtySessionController` now suppresses repeated same-session resize geometry before invoking Tauri `resize_session`; Terminal V2 session manager also dedupes pane resize geometry before reaching controllers. Native Terminal V2 keeps lifecycle callback adapters stable across parent status/session callback churn, and MCP fleet push skips identical snapshots before invoking `bridge_push_fleet_snapshot`. These guards protect native/legacy terminal paths from ResizeObserver/xterm fit and fleet/status feedback loops. A human-reported macOS Tauri dev retest records partial native-runtime manual QA evidence for resize/network-loop stability; the broader checklist remains pending.

### 2026-06-18 — PTY OutputTail single source of truth
Native PTY output-tail buffering, metrics, and agent banner detection now live in `src-tauri/src/pty/output_tail.rs`; `pty.rs` re-exports the shared types. Current Claude Code `Claude Code v*` detection and output-tail tests are owned by that module.

### 2026-06-18 — Terminal pane title controller shared across legacy and direct V2 panes
Pane title generation now routes through a shared CodeSpace title controller and `src/modules/codespace/services/pane-title/` source-policy module instead of duplicated `TerminalCell` logic. Direct Terminal V2 panes use the same retry/refresh/manual title path as legacy panes while keeping title derivation out of header UI. The controller uses fast local/default labels first, explicit OSC 0/2 terminal title intents from agents/skills, prompt-buffer titles when prompts are known, Claude JSONL titles when available, and token-free deterministic PTY-tail prompt extraction; PTY-tail Claude summarization is reserved for manual retry/generate actions so schedulers do not spend tokens in the background. Direct V2 headers replace the cwd/repository label with the generated title once ready, without showing a secondary title badge. Direct Terminal V2 panes must forward inline command submissions into the pane prompt buffer, and native PTY agent detection recognizes current `Claude Code v*` banners so manually launched Claude panes can promote to agent mode. Refresh timing decisions live in pure pane-title policies so idle floors, cooldown, prompt growth, PTY byte-watermark behavior, wait-floor retries, and agent-agnostic turn triggers are testable outside React. Title source orchestration lives in `pane-title-generation-runner.ts`; turn decision/watermark/retry behavior lives in pure pane-title turn evaluator/policy modules; React bridge-event and terminal input/output turn-trigger adapters are split out of `usePaneTitleRefresh` so hooks stay below the Terminal V2 maintainability budget. Title diagnostics are stored through `pane-title-diagnostics.ts` and automatically emit console/events in browser contexts for local QA.

### 2026-06-16 — Terminal V2 native initial command metadata
Native Terminal V2 opt-in runtime sends created-session `initialCommand` once after session start using `TerminalInputIntent` `initial-command` system metadata; reattached sessions do not replay it.

### 2026-06-13 — Terminal V2 pooled DOM live PTY mirror retry
Terminal V2 pooled DOM renderer now uses a runtime-level adapter and pane-container registry, and pooled xterm slots receive V2 session output via `TerminalV2SessionManager.subscribeOutput()` plus forward xterm input to the V2 session manager. A workspace switch regression showed parked pooled xterm DOM/canvas content can return blank, so host-created pooled slots now restore captured snapshots on rebind. Pooled slots now expose render health; if a render-capable pooled slot fails to report a render after bind, the pane falls back to its registered legacy-host slot and diagnostics show fallback panes. `useTerminalV2Session`, `useTerminalV2RendererBinding`, `useTerminalV2Geometry`, `useTerminalV2Input`, `useTerminalV2FocusSearch`, `useTerminalV2Suggestions`, `useTerminalV2Links`, and `resolveTerminalV2RevealPolicy` now own session output, renderer binding, resize routing, input write, focus/search, suggestion, link context, and reveal-state adapter seams. Production pooled DOM is enabled behind `terminalV2PooledDomRenderer` and user-reported production QA passed. Legacy terminal deletion remains out of scope until ownership-cutover and deletion-readiness gates pass.

### 2026-06-13 — Terminal V2 pooled DOM non-production default rollout
Terminal V2 pooled DOM renderer now defaults on for non-production local CodeSpace panes through `terminalV2PooledDomRenderer`, exposed in Settings → CodeSpace as a fallback switch to the legacy-host renderer. User-reported macOS Tauri dev post-rollout QA pass is recorded under `plans/codespace-v2/`. Legacy terminal deletion remains out of scope.

### 2026-06-13 — CodeSpace settings navigation
Settings now exposes a dedicated `CodeSpace` section (`/settings?section=codespace`) in the Settings sidebar. It renders `CodeSpaceSettingsSection`, including Terminal Runtime V2, terminal font size, pane title, and workbench editor controls, while preserving the existing General page.

### 2026-06-11 — CodeSpace terminal workspace switch repaint
CodeSpace terminal workspace activation applies terminal visibility, hidden-output drain, viewport refresh, fit, and PTY resize in a pre-paint layout effect. Legacy fallback behavior lives in `useLegacyTerminalRuntime`; native Terminal V2 owns the default local runtime. Because xterm canvas/compositor repaint can still settle asynchronously, the terminal runtime uses a `hidden | warming | settled` reveal handshake: first visible render enters `warming`, masks xterm with the terminal background, and the mask drops after xterm `onRender` or a double-rAF fallback. Once a terminal has rendered visibly, later workspace reactivations skip the mask and return directly to `settled` to avoid dimming valid terminal content. Optional WebGL promotion remains deferred to rAF/policy and is demoted on workspace deactivation to bound live GPU contexts (WebGL is disabled by default inside Tauri via `terminal-webgl-policy`). Regression coverage lives in `useLegacyTerminalRuntime.test.tsx`, with the plan at `plans/codespace-v2/task-terminal-workspace-switch-background-glitch.md`.

### 2026-06-11 — Swarm Agent avatar assets bypass Next image optimizer
Swarm Agent avatars use public files under `public/assets/agents/`. In exported Tauri production, Next's image optimizer route (`/_next/image?...`) is not available, causing the Agents surface to show broken image placeholders. `AgentAvatar` and Team card member avatars now render those local assets with `unoptimized`, preserving direct `/assets/agents/*-agent.png` URLs that Tauri can serve from the static bundle. Regression coverage lives in `AgentAvatar.test.tsx`.

### 2026-06-11 — Tauri dev/build bundles lotus-remote before Cargo
`bun run tauri:dev` and `tauri:build:exec` now run `scripts/build-lotus-remote-bundle.mjs` after MCP bundling and before Cargo/Tauri startup. This guarantees `lotus-remote/dist/lotus-remote.mjs` and the platform `lotus-remote-bin` exist for Rust `include_str!`/`include_bytes!` in fresh worktrees where ignored `dist/` artifacts are absent.

### 2026-06-11 — Swarm Team Agent Runtime Contract hardening
Swarm Team Terminal member launch now routes through `agent-runtime-contract.ts`, resolving each Team member into a launch spec with runner command, permission mode, MCP args, and Claude-family system-prompt injection. Non-Director Swarm Agent Panels receive durable persona context, applied skills, effort, and required `agent-result` output instructions instead of launching as bare role-labeled CLIs; Director context is composed with the same persona contract. Agent editing now exposes runner/custom command, safe/full access controls feed runner flags, custom team creation snapshots AgentDefinition prompt/skills/effort/permission/runner fields into TeamMember records, and default Team presets seed from canonical built-in AgentDefinitions. Swarm Teams are treated as the ADR-0017 global catalog in the hook/modal path: new teams no longer stamp `projectDir`, and `useSwarmTeams` no longer filters by active project. Team Terminal now has a small runtime snapshot module for launch phases, pending handoff, and injection readiness. Brainstorm Team Terminal launches set `mode=brainstorm` in the Swarm Task envelope and instruct the Director to produce options/tradeoffs/recommendations without code changes or task completion. MCP task tooling now exposes lifecycle-specific tools (`lotus_record_task_intake`, assignment plan, agent result, review request/verdict, guarded completion) so completion requires intake, evidence, and PASS review instead of relying only on raw task patching. Assignment result XML parsing lives in `assignment-result-parser.ts` for durable evidence extraction.

### 2026-06-10 — Swarm Intake Gate feedback-loop baseline
Swarm Task lifecycle now includes `blocked`, structured intake state, task blockers, and feedback timeline events. Team Terminal Director prompts require a Swarm Intake Gate, Task Understanding Brief, Grill Mode following `grill-with-docs` when ambiguous/high-risk, evidence-bearing agent results, and verifier review before completion. MCP task tools can update structured task state and append feedback events. Swarm task details render blockers/intake/timeline as human-readable cards while hiding raw XML, and Primary Director eligibility is centralized for Claude-family MCP-capable runners.

### 2026-06-10 — Swarm Team Terminal Claude readiness recovery
Swarm Team Terminal readiness recognizes the current Claude Code permission footer (`bypass permissions on`) as an idle prompt signal, including ANSI-styled xterm output where escape sequences split words. If text matching is still inconclusive, readiness falls back to an idle-after-output gate: once the runner has emitted output and then goes quiet briefly, the Director can become ready. Readiness timeout now surfaces a retryable warning without permanently closing the readiness gate, clears the stale warning after a late ready signal, and allows pending task injection once the Director is actually ready.

### 2026-06-10 — CodeSpace inactive workspace heavy work gating
Inactive CodeSpace workspaces keep terminal panes mounted and PTY sessions running, but Browser and Workbench panes receive `enabled=false` when their workspace is inactive or hidden behind fullscreen. Browser panes park native navigation/annotation work while disabled. Workbench panes skip file listing, editor file reads, git refresh, multi-repo git refresh, and diff refresh while preserving tabs, active editor state, dirty buffers, and pane state for reactivation.

### 2026-06-10 — CodeCanvas semantic overview LOD
CodeCanvas LOD now has `full`, `glyph`, and `overview` tiers with hysteresis. Overview begins below 12% zoom and renders map-like glyph blocks for standard nodes, pauses Canvas terminal rendering while keeping xterm hosts mounted, parks native Browser views, hides overview handles, and simplifies edge labels/opacity through a viewport LOD marker.

### 2026-06-10 — CodeCanvas Miro-style zoom baseline
CodeCanvas viewport bounds now support dense-board overview zoom down to 4%, while sparse boards retain readable minimum zoom. The canvas uses a custom bottom-right zoom control for fit all, zoom out, live percentage, and zoom in; default ReactFlow controls are hidden to avoid duplicate zoom UI. Canvas grid rendering adapts at overview zoom by expanding gap/mark size so the board remains spatially legible without dense visual noise.

### 2026-06-10 — CodeSpace lost integration audit recovery
CodeSpace recovery audit restored stale-overwrite integrations: the legacy fallback runtime is wired to `TerminalPaneRuntime`, hidden-output buffering, post-fit WebGL activation, terminal geometry guards, live-resize commit fit, and terminal write scheduling while preserving Canvas terminal `canvasTerminalId` injection. To avoid xterm WebGL canvas artifacts in desktop webviews, terminal WebGL `auto` policy is disabled inside Tauri by default; diagnostics can still opt in with policy `force`, or use `smooth-active-pane` to accelerate only the focused eligible pane; smooth mode demotes WebGL back to canvas when the pane loses eligibility, hides, or enters live resize. CodeSpace terminal panes use a clean theme-aligned inset xterm viewport surface, stable scrollbar gutter, terminal-owned background layering, and comfortable xterm metrics so PTY text feels smoother while the background remains coherent with the active workbench theme. `CodeSpacePage` uses `WorkspaceTerminalGrid` again for workspace-scoped handler binding and shared per-workspace `EditorFileStore` providers, mounts `FleetIdentitySyncer` for runtime provider/address promotion, and mounts `BridgeTaskIdleWatcher` so Bridge task cells trigger a follow-up only after PTY busy-to-idle metrics settle. The same recovery restores no-modal workspace close/home navigation: closing a workspace immediately terminates that workspace's runtime sessions, Home navigation preserves CodeSpace state without clearing sessions, and macOS `Cmd+W` is left to the focused terminal pane when applicable. Follow-up regression recovery restores multi-repo Source Control wiring through `useMultiRepoGit`, Bridge fleet context `address=`/role serialization with runtime-provider identity promotion, and terminal preference sync from `LOTUS_SETTINGS_CHANGED_EVENT` without echo-saving settings-originated updates.

### 2026-06-09 — CodeSpace recovered detached panel, file drop, and live resize wiring
CodeSpace right-panel detaching is wired through `CodeSpacePage` → `CodeSpaceRightPanel` → `PanelModeToolbar` and renders `DetachedRightPanelOverlay` as a fullscreen shadcn/Radix Sheet, not a draggable modal. Terminal file drop is wired through `TerminalV2GridRouteSelector`/`useTerminalFileDrop`, terminal-body drop-target data attributes, `TerminalFileDropOverlay`, and restored CSS; only the active visible workspace handles native file-drop events, drop targets must belong to that grid, and repeated native paths are deduplicated before terminal insertion/upload. Terminal grid resize uses the hook-based live DOM resize path again, with terminal-surface `fitViewport()` and legacy cell live-resize subscriptions restored so drag-resize stays smooth before commit.

### 2026-06-09 — CodeCanvas Snapshot Codec
CodeCanvas persisted snapshots now hydrate through `canvas-snapshot-codec.ts`, which validates schema version 1, quarantines unknown node types, drops edges whose endpoints were removed or invalid, normalizes invalid positions/sizes, and reports repair records. `CanvasSnapshotService` and `useCanvasBoard` use the codec before loading snapshots into ReactFlow.

### 2026-06-09 — CodeCanvas autosave observability
CodeCanvas autosave now exposes `idle | dirty | saving | saved | failed` state through `useCanvasAutosave`/`useCanvasBoard`, treats async save failures as visible state instead of fire-and-forget errors, and shows a topbar autosave chip with failure details for active projects.

### 2026-06-09 — CodeCanvas graph-run reliability baseline
CodeCanvas declares `@xyflow/react` as a direct dependency. Graph Run dispatch now preflights that all pending runnable nodes have live `AgentRunRegistry` handles, reports missing runners explicitly during preflight or release-time dispatch, detects detached cycles that appear after partial completion, finalizes stuck persisted runs as `error`, and settles the run controller so the UI does not remain in `running` forever.

### 2026-06-09 — Smart Convert Note IPC permission
Smart Convert task extraction uses the first-party Tauri command `smart_convert_note`; `src-tauri/permissions/main-app-commands.toml` must include it in `allow-main-app-commands` or the desktop webview reports `smart_convert_note not allowed. Command not found`.

### 2026-06-09 — Swarm Task → Team Terminal launch path
Tasks now support **Launch Team Terminal** alongside **Run with Workflow**. Launch intent is stored in sessionStorage with IDs only, `/swarm?surface=terminal&team=...&task=...` opens the persistent Terminal surface, and the Director receives a fresh `<swarm-task>` envelope only after its PTY is connected/ready. Team member runner fields are preserved in TypeScript, Swarm Terminal uses the canonical `pathToWorkspaceId(rootDir)` workspace ID, Director custom runners are blocked for MCP handoff, and the Terminal can be explicitly closed without changing task status. MCP fleet snapshots now combine CodeSpace, Canvas, and Swarm entries and support workspace/surface/team filtering instead of globally shadowing non-Swarm fleet. V1 enforces one active Team Terminal task focus per team: launching a different task is blocked unless the user opens the active focus or explicitly cancels it before launching. SwarmPage owns the pending terminal team selection so first-time Terminal mounts preserve `teamId` from task launch events and URL query params. Terminal URL launches also recover from missing sessionStorage by using `team`/`task` query params to fetch the latest task and inject it; the task envelope tells the Director to start immediately without waiting for user confirmation. `src/modules/swarm/services/team-terminal/team-terminal-launch-controller.ts` owns reusable Team Terminal Launch decisions, pending intent resolution, Director injection, task status patching, and pending-intent cleanup. `src/modules/swarm/services/team-terminal/agent-runner-readiness.ts` owns Agent Runner readiness adapters; Swarm panels no longer treat a fixed 8s delay as ready and instead wait for Claude/Codex/custom output signals or explicit startup failure/timeout. Swarm TUI dispatches split pasted prompt text from the submit key with a short delayed Enter so Claude Code panels start work instead of leaving `[Pasted text]` staged in the composer.

### 2026-04-24 — Bridge unified: removed Plan/Chat toggle
Dengan MCP sidecar Phase B2 shipped (5 `lotus_*` tools + built-in CLI tools), mode "Plan" jadi redundan — Claude sendiri yang decide via tool use pattern. User tinggal ketik prompt; Claude auto-detect: tools (Read/Write/Bash + `lotus_spawn_cell`, `lotus_dispatch_to_cell`, `lotus_wait_cell_idle`, `lotus_read_cell_output`, `lotus_list_fleet`) atau just reply.

- **Hapus:** `prompt-planner.ts` + test (12 tests), `planAndExecute` di `useOrchestrator` (+3 tests), `BridgeConsoleMode` toggle UI + `ModeToggle` components, prop `onPlan` di BridgeConsole.
- **Simplifikasi:** `useOrchestrator` sekarang hanya `submit/cancel/clear/resetSession/setActiveProvider/dispatchToCell` — tidak ada `getFleet`/`getContext`/`requestPlan`/`spawnTimeoutMs` option. `OrchestratorCell` jauh lebih tipis.
- **UX:** Single "Send" button. Placeholder direfresh supaya hint multi-use case (*"baca README"* ATAU *"spawn Codex untuk scaffold…"*). Session chip + reset button di header tetap.
- **Tests:** 303/303 hijau (turun 15 dari 318 karena test Plan mode dihapus). Lint clean (2 pre-existing).

### 2026-04-24 — Bridge Orchestrator M4b Phase B2 (MCP Cross-Cell — Full Tool Set)
Claude CLI sekarang punya 5 tools via Lotus MCP sidecar. User bisa minta *"spawn Codex lalu kirim perintah scaffold ke sana, tunggu idle, review outputnya pakai Claude"* — Claude melakukannya sendiri.

- **Output ring buffer** (`pty.rs`): tiap `PtySession` sekarang punya `OutputTail` (64KB rolling buffer) yang di-tee dari reader thread. Fn baru `read_output_tail(session_id, max_bytes, state)` untuk snapshot tanpa lock PTY writer.
- **4 endpoint baru** (`mcp_ipc.rs`):
  - `/v1/dispatch-to-cell` — resolve paneId → sessionId via fleet snapshot → panggil `pty::write_to_session` langsung. Optional `append_newline` (default true).
  - `/v1/read-cell-output` — snapshot tail output buffer per paneId (default 4KB, cap 64KB).
  - `/v1/spawn-cell` — emit Tauri event `mcp://spawn-cell`, await oneshot response dari frontend (timeout 6s), return paneId baru.
  - `/v1/wait-cell-idle` — poll output buffer tiap 180ms for idle signatures (default: `$ `, `% `, `> `, `? for shortcuts`), timeout konfigurabel (default 8s, cap 60s).
- **Round-trip plumbing**: `McpIpcState` sekarang carry `PtyState` + `AppHandle` + `pending: HashMap<req_id, oneshot::Sender>`. Tauri command `bridge_resolve_mcp_request(requestId, ok, data, error)` untuk FE post hasil.
- **Frontend spawn bridge** (`hooks/useMcpSpawnBridge.ts`): listen Tauri event, trigger `handleAddPaneToActiveWorkspace` lewat delegate callback, await `terminal:spawned` bus event, resolve ke Rust. Mounted di `CodeSpacePage` bersama `McpFleetPusher`.
- **Fleet snapshot** sekarang include `session_id` — dispatch/read-output bisa resolve paneId → sessionId di Rust tanpa roundtrip FE.
- **Sidecar** (`scripts/lotus-mcp-server.mjs`): 4 tools tambahan dengan JSON schema lengkap (required fields, enum provider, range bounds). Handler memetakan camelCase JS → snake_case HTTP.
- **Tests:** +7 Rust (dispatch auth/404, read-output empty-path, pending resolve, output tail ring), +5 Node handler (dispatch/read/spawn/wait-idle + validation), +2 regression via lint. Total: 318 frontend + 21 Rust green.

### 2026-04-24 — Bridge Orchestrator M4b Phase B1 (MCP Cross-Cell Tools — Foundation)
Bridge sekarang punya **MCP sidecar**: Claude CLI auto-discover Lotus tools dan bisa memanggil `lotus_list_fleet()` sama seperti `Bash`/`Read`.

- **Lotus IPC server** (`src-tauri/src/mcp_ipc.rs`): axum HTTP localhost, bind ke `127.0.0.1:0`, Bearer token auth pakai 32-byte hex secret yang diregenerasi tiap startup. Endpoints: `/v1/ping`, `/v1/list-fleet` (filterable by workspace id).
- **Config writer** (`src-tauri/src/mcp_config.rs`): atomic write `~/.claude/lotus-mcp-ipc.json` (perm 0600 di Unix) + non-destructive merge `mcpServers.lotus` ke `~/.claude.json`. Preserve existing keys. Cleanup discovery file saat graceful shutdown (match pid).
- **MCP sidecar script** (`scripts/lotus-mcp-server.mjs`): Bun-runnable, pakai `@modelcontextprotocol/sdk`. Stateless — re-read IPC config tiap tool call supaya Lotus restart tidak membunuh sidecar. Tool pertama: `lotus_list_fleet({workspaceId?})`.
- **Fleet push**: `useMcpFleetPush` hook mounted di `CodeSpacePage` (outside Bridge pane) push snapshot ke Rust state via `bridge_push_fleet_snapshot` (debounced 150ms). Sidecar dapat data up-to-date bahkan saat Bridge cell tidak terbuka.
- **Setup hook** (`lib.rs:setup`): spawn IPC task async, write discovery + mcp.json entry, locate `scripts/lotus-mcp-server.mjs` via ancestor walk (dev) atau `LOTUS_MCP_SERVER_PATH` (test). Semua best-effort — app tetap jalan kalau IPC gagal start.
- **Tests:** Rust 14 unit (auth, filter, config merge, discovery roundtrip), Node MCP handler 4 unit (fetch mock, error paths). Frontend 309 regression hijau.
- **Dependencies added:** `axum`, `tower`, `rand`, `hex`, `parking_lot` (Rust); `@modelcontextprotocol/sdk` (npm).
- **Yang belum (Phase B2):** tools `lotus_dispatch_to_cell`, `lotus_read_cell_output`, `lotus_spawn_cell`, `lotus_wait_cell_idle`.
- Plan: `plans/codespace-v2/task-bridge-m4b-mcp-cross-cell.md`.

### 2026-04-24 — Bridge Orchestrator M4a (Conversation Continuity via Claude CLI `--resume`)
Bridge Chat mode sekarang **real chat** — follow-up question bekerja, Claude ingat turn sebelumnya.

- **Policy:** Claude CLI dispawn dengan `--dangerously-skip-permissions` (YOLO) — sesuai project policy untuk agent otonom penuh. Flag di-hardcode di `agent-registry.ts` spec `claude-headless` (bukan opt-in per-call).
- **Session store** (`services/bridge/session-store.ts`): keyed by `workspace.id` dengan in-memory Map + opsional persist via factory. Module singleton + factory variant (DI-friendly, `createBridgeSessionStore`).
- **Resume flow**: `headless-session.buildCommand` sisipkan `--resume <id>` saat `resumeSessionId` ada. `onSessionId` callback diinvoke saat stream-json `system:init` event datang dengan `session_id`. Dispatcher forward lewat new `DispatcherEvent { kind: "session-id" }` → `useOrchestrator` state.
- **Auto-invalidate**: kalau spawn gagal dengan pesan mengandung "session" / "not found" / "resume", store entry dihapus otomatis supaya submit berikutnya mulai fresh.
- **UI**: `BridgeConsole` header tampilkan chip `session · <8-char-prefix>` + tombol `RotateCcw` untuk reset session (tombol muncul hanya saat sessionId aktif).
- **Tests**: +27 (session-store 14, dispatcher +3, useOrchestrator +2, BridgeConsole +3, headless-session +4, agent-registry +1). Full suite 309/309 green.
- **Docs:** plan di `plans/codespace-v2/task-bridge-m4a-conversation-continuity.md`.

### 2026-04-24 — Voice input removed from Bridge
Web Speech API turns out inconsistent across Tauri webviews (macOS WebKit / Windows WebView2) — dropped `BridgeMicButton` + `voice-input.ts` service + related Info.plist/Entitlements keys. Autonomous planner (`planAndExecute`, plan mode toggle, auto-spawn) unaffected.

### 2026-04-24 — Bridge Orchestrator Slice 3 (Voice + Autonomous Multi-Step Planner)
- Voice: `services/bridge/voice-input.ts` — DI-friendly wrapper over Web Speech API (Chromium/WebKit). Handles `not-allowed` / `no-speech` / `audio-capture` errors with friendly messages; default lang `en-US`. Tauri Info.plist gained `NSMicrophoneUsageDescription`/`NSSpeechRecognitionUsageDescription`; Entitlements.plist gained `com.apple.security.device.audio-input`.
- Planner: `services/bridge/prompt-planner.ts` — `requestPlan()` calls Claude headless with a strict JSON system prompt; `parsePlanJson()` handles fenced/preface prose, validates providers, rejects duplicate ids, and ensures `dependsOn` references exist; `topologicallySortSteps()` with cycle detection (`PlanCycleError`). One retry on parse failure.
- `useOrchestrator.planAndExecute(prompt)` — autonomous flow: plan → topo sort → per step find live cell by provider, emit `orchestrator:request-spawn` if missing (with 4s wait for `terminal:spawned`), then `dispatchToCell` with step.task. Plan summary rendered as markdown assistant message in the Bridge log; each dispatch logged as `tool-use` audit. Aborts cleanly via existing `cancel()`.
- UI: `BridgeMicButton` (integrated inside `BridgeConsole`, hides on unsupported browsers). `BridgeConsole` now has a `Chat / Plan` mode toggle — plan mode calls `planAndExecute`, routes to `Wand2` button (violet); voice transcript streams into textarea (interim + final handling).
- +22 tests (voice 7, planner 12, planAndExecute 3); total codespace suite 289/289 green. No new lint warnings.

### 2026-04-24 — Bridge Orchestrator Slice 2 (Fleet Awareness & Cross-Cell Dispatch)
- Added typed per-workspace event bus (`services/bridge/cell-event-bus.ts`) + React context (`cell-bus-context.tsx`); `CellBusProvider` wraps `CodeSpacePage` tree. Bus recreated per `workspaceId` → zero cross-workspace leakage.
- Extended `terminal-session-registry.ts` with `getAllTerminalSessions` / `getWorkspaceTerminalSessions` snapshots and `attachCellBus` to forward `terminal:spawned|exited|status|output` lifecycle into the bus.
- New derivation/collection services: `fleet-derivation.ts` (cells + sessions → `FleetMember[]` with provider detection via `agent-registry`) and `context-collector.ts` (workspace + buffers → `BridgeContext`).
- `useOrchestrator` gained `dispatchToCell({paneId, kind, payload})` — kicks off `orchestrator:dispatch` on the bus and appends a `tool-use` audit entry; `CellBusProvider` translates dispatches into `writeTerminalSession` / `closeTerminalSession`.
- New presentational components: `AgentFleetPanel` (provider icon, pulse dot, action menu) and `ContextChipsRow` (open tabs + active highlight + detach).
- `OrchestratorCell` now composes Console + ContextChips + EventLog + Fleet sidebar, reusing all Slice 1 machinery.
- +39 bridge/registry tests across 9 test files; full codespace suite 249 tests green. No Rust changes. Zero new lint warnings.

<claude-mem-context>
# Memory Context

# [Lotus] recent context, 2026-11-07 1:35am GMT+7

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 5 obs (2,175t read) | 118,320t work | 98% savings

### Sep 22, 2026
30926 10:05a 🔵 Pooled DOM Renderer `attachPane()` Not Idempotent — Duplicate Work on Same Pane
30927 " 🔵 WebGL Capability Probe Leaks GPU Contexts — 0 of 20 Probes Explicitly Released
30928 " 🔵 lotus-remote-bin Has Invalid Code Signature — Host Crashes with SIGKILL on Launch
30929 " 🔵 Supervisor Misclassifies Signal-Killed Child as Running Due to `try_wait` Returning None
30930 " 🔵 Terminal Pane Shows Accumulating Shell Prompts — PTY Resize or Output Replay Suspected

Access 118k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>

# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:
- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md

- Terminal V2 refactor work must use a scratch-built, Terax-inspired, scalable architecture with clear separation between business logic/runtime services and UI components. Prefer files capped around 300-400 lines of code for maintainability.
- Terminal V2 must be built runtime-core-first inside an isolated module so the legacy terminal module can be deleted once V2 stabilizes.
- Terminal V2 must use a compatibility adapter before replacing `terminal-session-registry.ts`, preserving external contracts for runtime session IDs, writes, resizes, output taps, bus events, MCP fleet, Bridge, Swarm, and Canvas integrations.
- Terminal V2 renderer architecture must use a true renderer pool as the primary design: PTY sessions belong to panes, xterm renderer slots are borrowed by visible or high-priority panes, hidden panes retain output via snapshot/ring state, and reveal binds a slot then restores, drains, fits, and repaints.
- Terminal V2 runtime provider must be app-level from the start so PTY sessions and runtime state survive route navigation. `TerminalV2Runtime` owns one `TerminalV2SessionManager` as the runtime-core lifecycle authority for pane/session state, bus events, taps, writes, resizes, attach/detach, and close semantics. Explicit pane/workspace close remains the authority for killing sessions. MVP restart restore must use the existing CodeSpace SQLite metadata snapshot for workspace/pane metadata only; old PTY session IDs, xterm buffers, renderer slots, and dormant rings must never be treated as resumable after app restart.
- Terminal V2 roadmap should include CodeSpace layout refactoring and architecture/performance optimization after runtime-core seams are stable. Build layout/performance policies as pure, testable modules first, then wire UI adapters.
- CodeCanvas refactor work must follow `src/modules/codecanvas/ARCHITECTURE.md`: scalable folder seams, production-hardening first, and implementation files capped around 500-600 lines of code for maintainability.

## Child DOX Index

Child AGENTS.md files:
- `apps/desktop/src/modules/factory/AGENTS.md` — Factory workflow, integration discovery state, configuration activation, and recovery UX.
- `src/modules/automation/AGENTS.md` — automation Inbox decisions, preview-only LGTM, ordered saves and publication eligibility.
- `src/modules/codecanvas/AGENTS.md` — CodeCanvas graph workspace, node/runtime contracts, snapshots, graph runs, and runtime-command seams.
- `src/modules/codespace/terminal-v2/AGENTS.md` — isolated Terminal V2 runtime replacement, metadata restore boundary, renderer-pool contracts, and compatibility-adapter rules.
- `src-tauri/AGENTS.md` — native Tauri backend, Rust command registration, IPC permissions/capabilities, and native verification.
- `src/styles/AGENTS.md` — shared global/route CSS organization and style verification.

Top-level ownership map:
- `src/app/` — Next.js App Router pages and browser fallback API routes.
- `src/components/`, `src/shared/`, `src/hooks/`, `src/contexts/` — reusable React UI, shared hooks, and app contexts.
- `src/lib/` — shared TypeScript service/adapters, including Tauri IPC wrappers and provider parsers.
- `src/styles/` — global and route-level CSS grouped by product surface; follow `src/styles/AGENTS.md`.
- `apps/desktop/src/modules/factory/` — Factory ticket-to-draft-PR workflow and agent setup; follow its child AGENTS.md.
- `src/modules/bridgeboard/` — Bridge board UI and orchestration surface.
- `src/modules/codecanvas/` — CodeCanvas nodes, canvas containers, runtime command seams, hooks, serialization, templates, graph runs, and tests. Follow `src/modules/codecanvas/AGENTS.md`.
- `src/modules/codechat/` — CodeChat UI, state, provider parsing, and tool-broker flow.
- `src/modules/codespace/` — terminal workspace UI, PTY session registry, and codespace state. Terminal V2 lives under `src/modules/codespace/terminal-v2/`; follow its child AGENTS.md.
- `src/modules/codeswarm/`, `src/modules/swarm/` — swarm/team/task surfaces, workflow capture, and team terminal features.
- `src/modules/settings/`, `src/modules/shell/` — settings and application shell domains.
- `src-tauri/` — native Rust backend, capabilities, permissions, and Tauri commands; follow `src-tauri/AGENTS.md`.
- `scripts/` — Node/Bun helper scripts and script tests.
- `types/` — repository-level ambient TypeScript declarations for optional test/runtime dependencies.
- `docs/` — durable docs and ADRs.
- `lotus-remote/`, `remotion-bar-chart/` — separate auxiliary workspaces; inspect local docs before editing.
