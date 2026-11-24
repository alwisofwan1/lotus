# 0025 — Agent Runtime Kernel: extract Agent Runner + Readiness as a shared kernel

- **Status:** Accepted (implemented — extracted to `src/lib/agent-runtime/`)
- **Date:** 2026-06-28
- **Related:** prerequisite for ADR-0024 (live terminal personas) Fase 0 slice 4 (live AgentNode spawn). Decided in the architecture grilling session, 2026-06-26.

## Context

A **Canvas Agent Node** in `live` mode must spawn an agent CLI as a persistent,
provider-portable, readiness-aware PTY (so it is dispatchable/handoff-able in Fase 2,
and supports Codex personas in Fase 3). That capability already exists — but it lives
inside the Swarm module:

- `src/modules/swarm/types/agent-runner.ts` — `resolveRunnerCommand(runner, custom,
  permissionMode)` maps `claude | ccs | csp | codex | custom` → command string.
- `src/modules/swarm/services/team-terminal/agent-runner-readiness.ts` +
  `createAgentRunnerReadinessTracker` — interprets PTY output to decide ready/pending/failed.
- `agent-runtime-contract.ts:78` composes them; `SwarmAgentPTYPanel.tsx` consumes them.

The domain model forbids the obvious shortcut: *"CodeCanvas is independent of the Swarm
Terminal Surface — shares no node types, PTY session registry, or API routes."* A direct
CodeCanvas→Swarm import would violate that surface↔surface independence.

But the launch/readiness primitive is not conceptually Swarm-specific. `runner` already
lives on `AgentDefinition` (the global **Swarm Agent** catalog used by CodeCanvas too).
It is a runtime primitive, not a surface concern.

## Decision

Extract the **Agent Runtime Kernel** — `Agent Runner` (`resolveRunnerCommand` and its
types) + the `Agent Runner Readiness Adapter` — into a module-neutral location
(`src/lib/agent-runtime/`), depended on by BOTH the Swarm Terminal Surface and
CodeCanvas live mode. Neither surface owns it.

- A **Live Agent Session** (canvas) and a **Swarm Agent Panel** (swarm) both spawn via
  the kernel; they still share no surface, session registry, or node type.
- This is a shared-kernel dependency, not surface coupling — surface↔surface
  independence is preserved.
- `CanvasAgentNodeData` and `CanvasAgentNodeRecord` gain a cached `runner` field
  (plumbed like `executionMode`), sourced from the agent's definition at create time,
  so the kernel can resolve the command on live spawn.

## Consequences

**Positive**
- One provider→command mapping and one readiness model for the whole app (no drift).
- Codex/custom live personas work on the canvas for free (Fase 3).
- Readiness adapter gives Fase 2 a principled "is this agent ready to receive a dispatch"
  signal instead of guessing.

**Negative / risks**
- A move-refactor across module boundaries: update all Swarm import sites. Mitigate with
  characterization tests (Swarm terminal readiness/runner tests must stay green) before
  and after the move.
- Risk of the kernel accreting surface concerns over time. Guard: the kernel may import
  neither `@/modules/swarm/**` nor `@/modules/codecanvas/**` (enforced by an invariant test).

**Migration**
- Pure move + re-export; no behaviour change. Swarm keeps working via updated imports;
  CodeCanvas live mode then depends on the same kernel.
