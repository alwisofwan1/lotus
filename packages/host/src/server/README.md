# Standalone Host

The Standalone Host is an embedded HTTP server that activates inside `lotus-remote` when `LOTUS_MODE=standalone`. It provides the same API surface that `ApiClient` already knows — PTY sessions, bridge chat, agent spawn, projects, notifications — without requiring the Lotus desktop app.

## Architecture

```
createStandaloneHost()
  │
  ├─ ProjectRegistry      load HostedProjects from PROJECTS_ROOT or PROJECTS_JSON
  ├─ PtyManager           create / list / kill node-pty sessions
  ├─ AgentRunnerRegistry  map AgentProviderId → AgentRunner
  │     ├─ ClaudeRunner   "claude"
  │     ├─ CodexRunner    "codex"
  │     └─ CcsRunner×N   "ccs:<account>" — auto-discovered from ~/.ccs/config.yaml
  │
  └─ Hono app             register routes, bearer auth middleware
        ├─ GET  /health
        ├─ *    /api/sessions/*     (PTY CRUD + SSE stream)
        ├─ POST /api/bridge/chat    (provider-agnostic chat)
        ├─ POST /api/agent/spawn-pty
        ├─ GET  /api/projects
        └─ GET  /api/notifications/stream
```

The Hono app receives all dependencies via `AppDeps` — no module-level state. This keeps every route handler unit-testable by injecting mocks.

## Key invariants

**`ApiClient` is the only caller.** The Telegram adapter never imports from `src/server/` directly. All communication goes through HTTP, even when the server runs in the same process. This preserves the option to extract the server to a separate process later by only changing `LOTUS_API_URL`.

**One `AgentRunner` per provider.** The registry is built once at startup. Runners are stateless — session state (e.g. `--resume` IDs) lives in `PtyManager` or a dedicated session store, not in the runner.

**PTY output is always buffered.** Every `PtySession` maintains a 64 KB ring buffer. SSE subscribers receive the buffer tail on connect, so a Telegram user who opens a session mid-run sees recent output immediately.

## Configuration

| Env var | Required | Description |
|---|---|---|
| `LOTUS_MODE` | Yes | `standalone` to activate the server |
| `LOTUS_API_KEY` | Yes | Bearer token for all `/api/*` routes |
| `PROJECTS_ROOT` | Either/or | Directory to scan for HostedProjects |
| `PROJECTS_JSON` | Either/or | Path to a JSON array of `HostedProject` objects |
| `SERVER_PORT` | No | Fixed port (default: random available port) |

`PROJECTS_JSON` takes precedence over `PROJECTS_ROOT` when both are set.

## AgentProviderId

```
"claude"          → ClaudeRunner: claude --print --output-format stream-json
"codex"           → CodexRunner:  codex --quiet
"ccs:<account>"   → CcsRunner:    ccs <account> -p "..." / ccs <account>:continue
```

CCS accounts are discovered automatically from `~/.ccs/config.yaml` at server startup. No manual config needed.

## Adding a provider

See `CLAUDE.md → Extending the server → Adding a new AgentRunner`.
