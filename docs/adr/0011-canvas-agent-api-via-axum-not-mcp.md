# ADR 0011 — Canvas Agent API routes live on the existing axum server, not MCP IPC

**Status**: Accepted

## Context

Canvas Terminal Nodes need to expose an HTTP API so that running agents (and users via button) can:
- Open a Canvas Browser Node (`POST /api/browser/open`)
- Navigate the browser (`POST /api/browser/navigate`)
- Pull a screenshot on demand (`GET /api/browser/screenshot`)

Two existing transport mechanisms were considered:

**MCP IPC** (`mcp_ipc.rs` / axum sidecar on a separate port, Bearer-authenticated via `~/.claude/lotus-mcp-ipc.json`): designed for Claude CLI tool extensions. Requires the agent to be running inside a Claude CLI session that has already loaded the MCP server. Shell scripts and `curl` calls from arbitrary PTY sessions cannot reach it without the MCP handshake.

**Existing axum API server** (`api_server/mod.rs`, fixed `API_PORT`, Bearer-authenticated via `api_key` in app state): already running for codespace fleet/session/task operations. Reachable by any process that knows the port and key — including `curl` calls inside PTY sessions.

## Decision

Canvas Agent API routes are added to the existing axum server under `/api/browser/*`. The `AGENT_CANVAS_API` env var injected into canvas PTY sessions points to `http://127.0.0.1:{API_PORT}`. A companion `AGENT_CANVAS_API_KEY` env var carries the Bearer token so agents can authenticate.

`AGENT_CANVAS_TERMINAL_ID` (the ReactFlow node ID of the spawning TerminalNode) is also injected at PTY spawn time, passed as a new optional parameter to the `create_session` Tauri command.

## Consequences

- Any shell command inside a canvas PTY session can call the Canvas Agent API with `curl` — no Claude CLI dependency.
- The API key must be kept short-lived or rotated carefully; it is visible in the process environment of all canvas PTY children.
- Adding `/api/browser/*` routes to the shared axum server means browser-related logic lands in `api_server/handlers/` alongside fleet/session handlers — a deliberate consolidation rather than a new sidecar.
- MCP IPC remains the correct transport for Claude CLI tool extensions (Lotus MCP tools); the Canvas Agent API is orthogonal to it.

## Implementation note — 2026-07-04

The agent inspection route is currently `POST /api/browser/snapshot`, which returns a bounded DOM/text/control snapshot rather than a bitmap screenshot. `POST /api/browser/search` extends the same Canvas Agent API family with query-ranked text/link/control results for the active Canvas Browser Node. Full click/fill automation remains outside this ADR and should use a dedicated automation adapter such as Playwright MCP while keeping the Canvas Browser Node as the visible companion.
