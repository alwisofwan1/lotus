# 0026 — CodeCanvas is a standalone ADE; Swarm is an optional consumer

- **Status:** Accepted — dipersempit oleh ADR-0036 (Swarm, konsumen opsional itu, sudah dihapus)
- **Date:** 2026-06-26
- **Deciders:** Alwi
- **Supersedes the boundary implied by:** 0016 (swarm-workflow-evolves-canvas-team-template), 0017 (swarm-teams-global-catalog)
- **Builds on:** ADR-0024 (live terminal personas), ADR-0025 (agent runtime kernel)
- **Reference model:** [CNVS](https://cnvs.dev/release/) — "CNVS is not an app agents appear inside; it is a tool agents can operate."

## Context

CodeCanvas is being grown into an Agent Development Environment (ADE) of the CNVS class
(`plans/agent-dev-environment/PLAN.md`). A review of the actual module boundary surfaced a mismatch
between how the product *feels* and how it is *built*:

**Measured coupling (non-test imports):** `codecanvas → swarm` = 11 lines across 3 files (all in the
Workflow-launch integration); `swarm → codecanvas` = 49 lines. The agent catalog
(`AgentDefinition`, `default-agents`, `agent-definitions-store`, `useCanvasAgentDefinitions`) already
**lives in codecanvas** and is imported *by* swarm. The live-agent runtime (Fase 0–2) is already
clean of swarm via the shared kernel (ADR-0023).

**The real friction is ownership/UX, not imports:**

1. **Persona authoring is Swarm-only.** `CanvasSettingsModal` states *"Agent/team/template management
   lives in the Swarm command center, not here."* `CanvasAddAgentMenu`, when the catalog is empty,
   offers only `→ Open Swarm`. To create/edit an agent the user must leave the canvas — even though the
   storage is canvas-owned. This is the felt "build it in Swarm first, then use it in CodeCanvas" pain.
2. **No installed-CLI detection.** Runners are a hardcoded dropdown `{claude, ccs, csp, codex, custom}`;
   there is no PATH/`which` probe and no per-CLI flags / skip-permissions / resume controls. CNVS's
   "Rescan" makes spawning frictionless; Lotus has nothing equivalent.
3. **The canvas is not agent-controllable.** MCP exposes terminal/fleet + task tools only. Agents
   cannot, via MCP, read canvas state or arrange/focus/rename/resize/move nodes, draw shapes/sticky/
   labels, screenshot, control browser nodes, or recall/remember. `useCanvasCommandCenter` (~15 ops)
   is in-process only; the "two doors" (NL + MCP over one op-layer) is aspirational, not real.
4. **Fragmented control plane.** Adding one MCP tool requires edits in 4 places (sidecar schema,
   sidecar handler, Rust route, Rust handler). CNVS uses one `ToolSpec` table as the single source of
   truth that generates MCP + CLI + Realtime schemas + docs.

## Decision

**CodeCanvas is the self-contained ADE. Swarm becomes an optional consumer layered on top of it.**

Concretely:

1. **Dependency rule (enforced by a guard test):** `src/modules/codecanvas/**` MUST NOT import
   `@/modules/swarm/**`. The dependency may only flow `swarm → codecanvas` (and both → the shared
   kernel). The current 3 codecanvas→swarm import sites (Workflow launch/capture) are inverted: the
   Workflow integration becomes **swarm-owned adapter code**, or rides a thin shared workflow *type*
   that lives below both.

2. **Canvas owns its primitives.** A shared **agent-catalog** seam holds agent definitions, the
   persona **editor** (relocated out of swarm), and **installed-CLI detection**. CodeCanvas can create,
   edit, and spawn agents and terminals end-to-end without ever entering Swarm.

   **Spawn-first, auto-named (CNVS model).** The primary way to get an agent is to **pick an installed
   CLI** (Claude/Codex/Cursor) — naming is automatic. A curated **name-pool** assigns the next unused,
   per-canvas-unique handle (e.g. "Skye · Claude Code"), resolving to a stable `id`. The **handle is
   decoupled from the persona**: `AgentDefinition` (role/model/prompt/skills) becomes an *optional
   overlay* ("spawn with persona…"), never a prerequisite for getting a named, working agent. This is
   what makes spawning frictionless in CNVS, and removes the felt "author in Swarm first" step. See
   `plans/codecanvas-standalone-ade/PLAN.md` §3.5.

3. **One op-layer, three doors.** `useCanvasCommandCenter` is the single canonical operation layer.
   A single **ToolSpec** is the source of truth that projects those ops to: (a) the NL command bar
   (in-process), (b) MCP `lotus_*` tools for agents, and (c) — optionally — a `cnvsctl`-style local
   CLI. Canvas manipulation (arrange/focus/rename/resize/draw/read-state/screenshot) becomes
   agent-reachable, making the canvas "a tool agents operate."

4. **Swarm stays, demoted.** Swarm remains as an *optional* orchestration surface (workflows/teams)
   that consumes the canvas. It is never required to use CodeCanvas. ADR-0016/0017 still hold for what
   Swarm does — they no longer imply CodeCanvas depends on Swarm.

## Consequences

**Positive**
- A clean, production-grade ADE that matches the CNVS mental model: open canvas → Rescan CLIs → spawn
  agents → agents operate the canvas. No detour through a second app.
- The dependency graph becomes a DAG with codecanvas above swarm; the guard test prevents regression.
- A single ToolSpec removes the 4-place tool-authoring tax and unifies NL/MCP/CLI behavior.

**Negative / cost**
- Migration work: relocate `AgentEditorModal` and the agent-catalog seam; invert the Workflow
  integration; build CLI detection; refactor the MCP surface to a generated one. Phased in
  `plans/codecanvas-standalone-ade/PLAN.md`.
- Two op surfaces (in-process + MCP) must stay behaviorally identical — mitigated by deriving both
  from the one ToolSpec rather than hand-maintaining each.
- Short-term churn for swarm (it must absorb the Workflow adapter and keep importing canvas types).

**Neutral**
- No change to the runtime kernel (ADR-0023) — it is already the correct leaf.
- Headless graph-run path (Run Graph) is untouched; this ADR is about the live ADE boundary.

## Alternatives considered

- **Fold Swarm into CodeCanvas (single product).** Cleanest end-state but highest migration cost;
  deferred — can still happen later since this ADR already inverts the dependency.
- **Extract only a shared agent-catalog, keep both worlds.** Lowest risk but leaves "two worlds" and
  does not deliver the agent-controllable canvas. Rejected as insufficient for an ADE.

## Verification

- Guard test: no `@/modules/swarm` import under `src/modules/codecanvas` (mirrors the ADR-0023 kernel
  guard).
- E2E: open `/canvas` with an empty catalog → create an agent persona in-canvas → Rescan picks an
  installed CLI → spawn → the agent uses an MCP canvas-op tool (e.g. focus/arrange a node) — all
  without visiting `/swarm`.
