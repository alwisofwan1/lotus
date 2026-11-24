# Standalone host as a headless, agent-driven orchestrator (Director-in-host)

## Status

accepted — but the Director's **runtime scope** (here written as claude
`--print`) is amended by [ADR-0020](./0020-orchestrator-is-provider-portable-headless-billing.md):
the orchestrator is provider-portable (claude **and** codex) because of the
15 June 2026 Anthropic headless-billing change. The event-driven, agent-driven,
contract-parity decisions below stand; only "claude only" is superseded.

> **That billing change was withdrawn on the day it was due to start** (verified
> 2026-08-07 — see ADR-0020's addendum). Provider portability still holds, as
> insurance rather than mitigation; the cost reasoning behind it does not.

## Context

lotus-remote already ships a **standalone** deployment mode: a self-hosted HTTP
host (PTY manager, agent runners, fleet/bridge routes, notification bus) plus a
Telegram adapter, runnable on a VPS without the Lotus desktop app (ADR-0002).

Today that host is a **substrate, not an orchestrator**. Its routes spawn a
single agent into a PTY, write to a PTY, read a 64KB ring buffer, stream output,
and run a one-shot `claude --print --resume` chat. `/api/fleet/dispatch` is
literally `session.write(command)` — there is no routing intelligence. The
orchestration brain (Swarm Director, intake gate, task assignment, workflow
runs, fleet coordination via MCP, worktree isolation) lives entirely in the
desktop app. In standalone mode, the human is the orchestrator via Telegram.

We want the standalone host to behave like a single-VPS autonomous orchestrator
in the class of Hermes Agent (Nous Research) and OpenClaw: an always-on,
self-hosted, multi-agent coordinator that accepts goals from a chat platform and
drives them to completion.

Two facts make this far cheaper than it appears:

1. **Lotus orchestration is already agent-driven, not code.** The Bridge wraps
   Claude as a *persistent reasoning engine*; the **Primary Director** is an
   agent with MCP/tool coordination, not a hardcoded state machine. So there is
   no orchestration engine to port — only a prompt and a tool contract.
2. **The MCP sidecar is backend-agnostic.** `scripts/lotus-mcp-server.mjs` reads
   a discovery file (`--discovery` → `{port, secret}`) and forwards every tool
   call to `http://127.0.0.1:<port>/v1/*`. The full orchestration tool surface
   (fleet + task lifecycle) is already defined there. Today `/v1/*` is served by
   the desktop axum (`src-tauri/src/mcp_ipc.rs`).

## Decision

- The **Standalone Orchestrator** gains a **Headless Director**: a long-lived,
  **event-driven** `claude` session (resumed via `--resume`) given the Lotus MCP
  tools and an orchestrator system prompt. Orchestration emerges from the agent's
  reasoning over the tool surface — **no orchestration state machine is written
  in TypeScript** (rejected alternative: a code FSM, which would duplicate the
  desktop Swarm and create two sources of truth).
- The Director is invoked event-driven, never as a perpetual reasoning loop: on
  a remote-submitted goal, on a worker-idle notification, and (later) on a
  scheduled tick. Idle between events costs zero tokens. This reuses the existing
  `bridge_chat` pattern. (Rejected: a persistent interactive PTY Director —
  fragile lifecycle, unbounded context, continuous token cost.)
- The standalone host implements the **same `/v1/*` MCP-IPC Contract** that the
  desktop axum implements (fleet + `tasks/*` + `wait-cell-idle` + `ensure-fleet`)
  and writes its own `lotus-mcp-ipc.json`. The existing MCP sidecar and the
  Director prompt are reused **verbatim** — only the discovery file differs.
  (Rejected: a sidecar `/api/*` mapping mode or a separate standalone sidecar —
  both fork the tool surface that must stay in sync.)
- **Swarm Task** state is persisted in a **local JSON file store** with atomic
  writes, matching the existing `work-store` / `bridge-store` / `session-store`
  conventions and the lotus-remote DI + 300-line rules. (Rejected: SQLite —
  exceeds single-operator volume and adds a native dep + migrations; reusing the
  desktop store — impossible, there is no desktop in standalone mode.)
- **First cut** ships: the `/v1/*` mirror (fleet + tasks), the file task store,
  the Headless Director session + orchestrator prompt + MCP discovery pointed at
  standalone, a **worker concurrency cap with a queue**, and **re-poke on
  worker-idle** (notification bus triggers a Director `--resume`).
- **Scope is full-VPS with a soft workspace-root.** Agents run as the VPS user
  with full permissions (the Hermes/OpenClaw model for a dedicated personal VPS).
  A configurable **workspace root** (default `~/lotus-workspaces/`) is the default
  `cwd` and where clones land, but it is a convention, not a sandbox — a YOLO PTY
  shell can leave it. (Rejected for V1: a dedicated limited unix user, and
  per-task containers — real confinement, but deploy cost beyond a single trusted
  VPS. App-level path allowlists were rejected outright as security theatre given
  the agent has a raw shell.)
- **Cloning, file management, and cross-workspace navigation need no new
  capability**: a worker/Director PTY is a real shell, so `git clone` and `cd`
  are ordinary commands, and the orchestrator moves between workspaces by
  spawning/dispatching cells with different `cwd`. The one gap is *visibility* —
  the `ProjectRegistry` is built once at host start, so a freshly cloned repo is
  usable but unlisted. V1 makes the registry **read the workspace root live**
  (dynamic re-scan) so clones become first-class workspaces with no restart.
  (Rejected for V1: a dedicated `lotus_clone_repo` provisioning tool — the
  agent clones via shell and the re-scan surfaces it; a structured tool is a
  later nicety.)
- **Deferred**: a proactive scheduler/cron, and per-worker git worktree
  isolation (workers share `cwd` initially).

## Consequences

- A single VPS can run goal → decompose → dispatch → monitor → complete with no
  desktop app, reaching the Hermes/OpenClaw capability class for the
  Claude-centric case.
- The "two sources of truth" risk is contained to a **contract**, not code: as
  long as standalone serves the same `/v1/*` surface and task schema, the
  Director prompt and sidecar are identical to the desktop's. Divergence is a
  contract-drift problem, caught by a shared contract test, not a logic fork.
- New surface area in the standalone host: the `/v1/*` task-lifecycle endpoints,
  the file task store, the Director supervisor (spawn/resume/recover), the
  concurrency queue, and event wiring from the Telegram adapter and notification
  bus. Each must obey TDD + 300-line + DI rules.
- Token cost is bounded by the event-driven model; a runaway Director is bounded
  by the worker concurrency cap.
- This is a deliberate scope expansion of lotus-remote from "remote control
  surface" to "headless orchestrator". The desktop remains the richer,
  human-steered surface; the standalone path is the autonomous one. They share
  the **MCP-IPC Contract** and the Director prompt, and must not diverge those.
- If a scheduler is added later, it becomes a third Director trigger alongside
  remote-goal and worker-idle — it must not become a parallel orchestration
  entry point that bypasses the task store.
- **Implementation is scoped strictly inside `lotus-remote/`** (no `src-tauri/`
  changes). Two outside assets are **vendored in** so the standalone host
  deploys on a bare VPS: the MCP sidecar (`scripts/lotus-mcp-server.mjs`, copied
  unmodified) and the Director prompt (ported from the desktop into a
  lotus-remote asset). The desktop `mcp_ipc.rs` is used only as a read-only
  contract fixture. Drift between the vendored copies and their desktop sources
  is the accepted cost; record source commits so a future sync is traceable.
