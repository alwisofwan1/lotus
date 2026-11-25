# 0024 — Canvas agents default to live persistent terminal personas

- **Status:** Accepted (implemented)
- **Date:** 2026-06-28
- **Amends:** the promote-agent-terminal decision, which stated AgentNode "does not migrate into PTY" and "keeps headless and one-shot" as default. This ADR reverses the **default**, not the existence of headless mode.
- **Related:** ADR-0025 (Agent Runtime Kernel — the spawn mechanism), ADR-0020 (provider-portable headless billing)

## Context

CodeCanvas today runs two disconnected agent execution worlds:

1. **Canvas Agents** (`AgentNode`) — headless, one-shot `claude --print
   --output-format stream-json` via `run_codechat`. Dies after one answer
   (180s cap). Coordinates only through pull-based N2 handoff / N3 context bus.
   Cannot use MCP fleet tools; invisible to the Terminal Cell fleet.
2. **Terminal Cells** — persistent PTY (`pty.rs`, 64KB ring buffer, OSC 133 idle).
   Coordinates richly via `lotus_*` MCP tools (read/dispatch/wait/spawn/close).
   Not part of the canvas graph or context bus.

We want CodeCanvas to be an **Agent Development Environment** in the class of
[cnvs.dev](https://cnvs.dev): every agent is a **live, watchable terminal persona**
that can read other agents' terminals and hand off work, controlled by a
natural-language command bar. That model requires agents to be persistent and
mutually visible — which the headless one-shot model cannot provide.

The earlier promote-agent-terminal work added a one-way "Promote to Terminal"
escape hatch but deliberately kept headless as the default to preserve Run Graph /
PlanNode / checkpoint-replay determinism (N1–N4). That determinism is still
valuable — for graph execution. It is the wrong default for interactive agent work.

## Decision

1. **Live persistent terminal is the default execution mode for an AgentNode.**
   A new AgentNode is a PTY-backed persona (name · engine · model · cwd ·
   permissions header), watchable and interactive. It owns a **Live Agent Session**
   spawned through the **Agent Runtime Kernel** (`resolveRunnerCommand` +
   readiness adapter — ADR-0025), NOT through the claude-only
   `buildPromotedAgentCommand`. The node keeps its agent identity (definition,
   skills, N2/N3 wiring); only the runtime transport is the shared PTY. Rationale:
   CNVS-parity requires provider-portable personas (Claude **and** Codex) that are
   dispatchable/handoff-able (Fase 2) — which the Agent Runner + readiness model
   already delivers and the promote helper cannot.

2. **Headless one-shot is retained as a distinct mode**, not removed. It remains
   the execution path for Run Graph, PlanNode, and Critic nodes, where determinism
   and checkpoint/replay (N1) matter. The node carries
   `executionMode: "live" | "headless"`; the two modes **share** prompt assembly
   (`buildAgentRunPrompt`) and cwd resolution, differing only in transport
   (PTY vs `--print`).

3. **Live agents register into the MCP `canvas_fleet` snapshot**, making them
   visible to cross-agent read/dispatch/handoff tools — the prerequisite for
   cnvs.dev-style coordination.

4. The promote-agent-terminal one-way action is **superseded**: a Canvas Agent Node
   created today is always `live`. Scope is **PTY-only (CNVS-focused)** — the
   pre-existing `headless` `run_codechat` path and N1–N4 graph/critic stay working
   for old snapshots but are **dormant** (not extended), and there is **no in-UI
   live↔headless toggle**. The "Run Graph vs live" determinism question is therefore
   out of scope (the graph engine is left untouched). (Grilling 2026-06-26.)

5. The grilling session (2026-06-26) revised the spawn mechanism: live spawn uses
   the **Agent Runtime Kernel** (ADR-0025), not `buildPromotedAgentCommand`. The
   prompt-level `operatingMode: "live"` contract (slice 1-2, shipped) still stands —
   it is the *contract* told to the model; the kernel is the *transport* that launches
   the CLI. `CanvasAgentNodeData` must also cache the agent's `runner` (currently only
   model/effort/permissionMode are cached) so the kernel can resolve its command.

## Consequences

**Positive**
- Agents become watchable, interactive personas → the cnvs.dev experience.
- Cross-agent read + handoff becomes possible (live agents in `canvas_fleet`).
- No rewrite: reuses PTY layer, terminal runtime, promotion helper, prompt assembly.
- Graph determinism preserved — headless mode still backs Run Graph / Critic.

**Negative / risks**
- Two execution codepaths to maintain (mitigated by sharing prompt + cwd logic).
- Live `claude` interactive vs headless `claude -p` may differ in billing/limits
  post Anthropic June 2026 policy (see ADR-0020). — **Not a live risk:** that
  policy was withdrawn before it took effect (ADR-0020 addendum, 2026-08-07), so
  both paths draw from the same subscription pool today. This ADR's decision never
  rested on billing anyway; it rests on personas needing to be persistent and
  mutually visible.
- Large prefilled prompts in an interactive terminal (mitigation: temp prompt
  file + `claude ... "$(cat file)"`, per promote-agent-terminal §Risks).
- Handoff loops between live agents (mitigation: depth/iteration guard or
  mandatory human-gate circuit breaker).

**Back-compat**
- Existing snapshots decode with their current (headless) behaviour; only newly
  created nodes default to live. Decode logic defaults missing `executionMode`
  to `"headless"` for pre-ADR nodes.
