# 0030 — Canvas agent→agent dispatch routes through one message bus (name-addressed); spawn injects the capability

- **Status:** Accepted
- **Date:** 2026-06-29
- **Related:** ADR-0024 (live terminal personas), ADR-0027 (runner-first launch), ADR-0029 (live feedback loop). Builds on the NL Intent Registry / `resolveNodeByName` / `sendAgentMessage` (plan `plans/codecanvas-nl-full-coverage/`).
- **Decided via:** confirmed spike, 2026-06-29 (root cause below is evidenced, not assumed)

## Context

A user can spawn live agents on the canvas (ADR-0027) and message one from the NL bar
(`dispatch` → `sendAgentMessage`). But **agent→agent** messaging fails: "tell Sage to say hello to
Rowan" — Sage calling `lotus_dispatch_to_cell` never reaches Rowan.

**Root cause (spike-confirmed).** There are two non-connected delivery substrates:

1. **Canvas-internal (works):** `sendAgentMessage` → `agentReplyRegistry` handle, keyed by **node
   id**. Delivery is *session-resume*, not a raw byte write (canvas-agent-messaging migrated off
   PTY-write deliberately). This is what the NL bar and the Phase D loop controller use.

2. **MCP fleet (fails for canvas):** `lotus_dispatch_to_cell` → IPC → Rust
   `pty::write_to_session(session_id, …)`, keyed by a **PtyStore session id**.

The seam, with evidence:
- `canvas-fleet.ts` pushes canvas agents with `pane_id = node id`, `workspace_id = canvas:<project>`,
  `session_id = s.sessionId` — and its own comment says they are **"not PTY-dispatchable."**
- That `session_id` is the **runner conversation id** (captured per ADR-0027 P5), **not** a PtyStore
  key.
- `mcp_ipc.rs::dispatch_to_cell` polls for a `session_id` (404 "no live session" if absent), then
  **unconditionally** `pty::write_to_session(session_id, …)` — no `canvas:` special-case.

So: codex / pre-capture claude → 404; post-capture claude → write to a non-existent PtyStore key →
no-op. Either way the message is lost. The failure is **by design**, not a small bug.

Two further gaps make even a fixed delivery unreliable: the agent must *know* the tool exists and
*know how to address* a peer; and `dispatch_to_cell` addresses by opaque `pane_id`, forcing an extra
`lotus_list_fleet` reasoning step (slow, fragile).

## Decision

Collapse to **one delivery substrate**, address peers **by name**, and inject the **capability** at
spawn. Three parts:

1. **One bus.** All delivery to a canvas agent — user→agent, loop controller, and **agent→agent** —
   funnels through `sendAgentMessage` (the proven, session-resume path). The PTY-write path is
   abandoned for `canvas:` targets.

2. **MCP dispatch round-trips to the bus (not the PTY).** `dispatch_to_cell`, when the resolved
   target is a `canvas:` member, **does not** call `pty::write_to_session`. Instead it mirrors the
   existing **spawn round-trip** (`register_pending` → `emit_to_frontend("mcp://dispatch-to-canvas-
   agent", {requestId, target, text})` → await the oneshot, with a timeout) and the frontend resolves
   it via the existing `bridge_resolve_mcp_request` command. The frontend handler resolves the target
   and calls `sendAgentMessage`.

3. **Name-addressed, resolved at call time.** The target is a canvas agent **name** ("Rowan"),
   resolved by the frontend with `resolveNodeByName` / the live roster **at dispatch time** (always
   fresh — no stale snapshot, no agent-side `list_fleet` step). Resolution returns the node id for
   `sendAgentMessage`.

4. **Receipt, not silence.** The tool returns the existing `SendResult`
   (`delivered | queued | skipped`) — including `queued` for an agent that is live but still starting
   — so the calling agent (and the trace) sees the real outcome. `not-found` / `ambiguous` are
   explicit errors, never a silent pass.

5. **Spawn injects the capability into the SYSTEM PROMPT, not the data.** When a live agent spawns, a
   short **static** capability line goes into its **system prompt** (`--append-system-prompt`,
   claude-family, opt-in via `includePeerCapability`): it is on a shared canvas and can message a
   teammate **by name** via the tool, discovering peers at call time with `lotus_list_fleet`. It does
   **not** inject the task, and **not** a roster snapshot (stale). **Correction (2026-06-30):** a first
   implementation prepended this to the user's *task message* (in-band) and was reverted — it polluted
   normal single-agent work ("fix the bug" arrived with a messaging preamble). Research is decisive:
   tool-usage policy belongs in the system prompt; per-message injection is a context-pollution
   anti-pattern. The capability text also self-gates ("only when the task calls for reaching another
   agent") so solo work stays clean. A separate, prior bug — idle peers had `is_alive=false` and so were
   filtered out of `lotus_list_fleet` — was also fixed (canvas-fleet: idle is now alive/addressable).

6. **Runner-agnostic reach.** The fleet tools must be callable from any runner, not only claude
   (which gets them via `~/.claude.json`). Register the lotus MCP server per-runner where supported
   (e.g. codex `~/.codex/config`), and/or ship a tiny `lotus-send <name> <message>` shim on `PATH`
   that posts to the same IPC endpoint — universal for any runner with a shell.

7. **Loop-safety unchanged.** The existing `dispatch_to_cell` rate-guard (cap dispatches per target
   in a window) still applies at the choke point — an A→B→A ping-pong trips it. A round-trip timeout
   bounds a stuck frontend.

**Non-goals / not chosen:**
- Writing to a canvas agent's PTY from Rust directly — delivery is session-resume, owned by the
  frontend; a round-trip is correct and the IPC cost is negligible. The latency we cut is the agent's
  extra LLM turn (removed by name-addressing), not the IPC hop.
- Injecting the *task* or a *roster snapshot* at spawn as the messaging mechanism — the first only
  seeds one message; the second goes stale.

## Consequences

**Positive**
- Agent→agent works through the one path already proven for user→agent and the loop controller — small
  blast radius, high confidence.
- Faster interaction: name-addressing removes the `list_fleet` round-trip; spawn-injection removes the
  "agent didn't know to" failure.
- Production-hardened: deterministic name resolution, explicit receipt, existing rate-guard + a new
  round-trip timeout, runner-agnostic reach.
- Reuses `sendAgentMessage` / `SendResult` / `resolveNodeByName` / the spawn round-trip plumbing —
  little genuinely new.

**Negative / risks**
- A round-trip per agent→agent message (vs a direct Rust write). Accepted: it is local IPC, and
  delivery *must* go through the frontend resume logic anyway.
- Per-runner MCP registration / the shim is extra surface to maintain; the shim keeps it uniform.
- Name collisions on the canvas → `ambiguous`; surfaced as an actionable error (names are already
  unique-by-pool per ADR-0027, so rare).

**Domain language (CONTEXT.md)**
- **Canvas message bus** (single delivery substrate = `sendAgentMessage`), **name-addressed
  dispatch**, **capability injection** (spawn-time), **delivery receipt** (`SendResult`) added.
  Clarified: canvas agents are *bus-dispatchable*, not *PTY-dispatchable*.

## Implementation plan (steps map to the build)

| Step | Scope | Status |
|---|---|---|
| 1 | Unified delivery: Rust `dispatch_to_cell` `canvas:` branch → `mcp://dispatch-to-canvas-agent` round-trip; `useMcpCanvasDispatchBridge` → `resolveCanvasDispatchTarget` → `sendAgentMessage`; `SendResult` receipt | ✅ (cargo check + tsc clean; mounted in CanvasPage) |
| 2 | Spawn capability injection — `peerCapabilityNote` (roster-free) prepended to a briefed spawn in the command center `create-agent` (covers NL + ⌘K). Bare-spawn (no brief) injection deferred | ✅ (brief path) |
| 3 | Runner-agnostic SENDER reach (codex etc. initiating) | ⏸️ **deferred** — see Known limitation |
| 4 | Hardening + tests — 6s round-trip timeout, not-found/ambiguous explicit errors, reused rate-guard, receipt; unit tests for `resolveCanvasDispatchTarget` + `peerCapabilityNote` | ✅ (1400 codecanvas tests green) |

## Known limitation (2026-06-30)

**Only claude-family runners can INITIATE an agent→agent message; all runners can RECEIVE one.**
Sending requires (a) the `lotus` MCP fleet tools and (b) awareness of when to use them. claude-family
agents get both — the tools via `~/.claude.json` and the capability via `--append-system-prompt`.
codex/cursor/custom get neither today: codex reads `~/.codex/config.toml` (TOML, would need a
`toml_edit` dependency + a non-destructive write into the user's file) for the tools, and has no
`--append-system-prompt` equivalent for the capability — so registering the tools alone would leave it
with no awareness of when to dispatch. Given the lead/orchestrator is normally claude, this is deferred
as low-ROI/high-risk. Delivery to a codex worker already works (the receiver needs nothing). Revisit via
a runner-agnostic `lotus-send` PATH shim + a codex-native instructions channel (`AGENTS.md`) if needed.

**Verification (2026-06-29):** `cargo check` exit 0; `tsc --noEmit` clean on touched files; full
CodeCanvas vitest 1400/1400 green. **E2E VERIFIED claude→claude in the running dev app:** spawned Sage
+ Rowan; instructed Sage to message Rowan via its lotus fleet tool → Sage `Called lotus-dev 3 times`
and reported delivery; console breadcrumb `[canvas-dispatch] delivered {result:{delivered:["<rowan
id>"],queued:[],skipped:[]}}`; Rowan received the message and responded. Step 1 confirmed working in
production path. (Sage resolved Rowan by node id via list_fleet — name-addressing works; the spawn was
bare so Step 2 capability-note wasn't exercised, yet claude inferred the tool from the explicit
instruction.)
