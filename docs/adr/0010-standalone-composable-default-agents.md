# Default agents are standalone-but-composable; coordination lives in the orchestration layer

The 15-member **Default Agent Roster** (one per shipped avatar) is built as self-contained specialists. Each prompt assumes no team topology and never references `docs/agent-team/`, plan.md ownership, or named teammates; instead each agent consumes whatever **Handoff Artifact**/**Context Artifact**/note context the **Run Prompt** injects and emits a clean structured summary for downstream consumers. Coordination is the orchestration layer's job — **Handoff Edge**, **Shared Context Bus**, **Critic Node**, **Canvas Run Graph**, and the future Teams/Workflows surfaces.

## Status

accepted

## Context

The prior `ENGINEERING_TEAM` preset baked coordination into every agent prompt via a free-text handoff convention (`plan.md → architecture.md → progress.md → review.md`, explicit upstream/downstream naming). The shared `agent-run-prompt.ts` assembler reinforced this by injecting `HEADLESS_PREAMBLE` ("coordinate only through docs/agent-team/"), `PLAN_MD_FORMAT_INSTRUCTION`, and a teammate `rosterBlock` into *every* run, regardless of the agent.

We needed a coordination model for an expanded 15-agent default catalog spanning roles (researcher, analyst, product, support, ops, database, critic) that do not fit a single linear build chain.

## Decision

Separate agent **capability** from agent **composition**. Agent Definitions are standalone-but-composable; all coordination moves to the orchestration layer, which already provides robust, explicit context-passing primitives. Concretely:

- Rewrite the 15 prompts as self-contained specialists (orient → plan → do → verify → summarize), worded to consume injected context and produce structured output.
- `HEADLESS_PREAMBLE` no longer says "coordinate only through docs/agent-team/"; it points at the injected structured context.
- `PLAN_MD_FORMAT_INSTRUCTION` (Plan Output Contract) and `rosterBlock` become Planner-role-only instead of universal — gated by a flag on the run parts, since only the Planner emits plan.md.

## Considered Options

- **Keep the handoff-file model (status quo).** Rejected: recent practice (Cognition's "Don't Build Multi-Agents", Anthropic's multi-agent research system, LangChain) converges on this being the fragile pattern — implicit decisions in free-text conventions cause conflicting assumptions; robust systems pass context explicitly.
- **One big team where all 15 coordinate via handoff files.** Rejected: forces non-build roles (researcher/support/product) into a build chain unnaturally.
- **Plain standalone (context-blind).** Rejected: agents would ignore the Handoff/Context-Bus context already injected, wasting the N2/N3 substrate.

## Consequences

- Changing the shared assembler affects all canvas agent runs, including the Plan node path; the plan.md format/roster injection becomes conditional, so the Plan node must signal Planner runs.
- `SOLO_IMPLEMENTER` is retired; Task "single" mode uses the **Coder** definition. `ENGINEERING_TEAM` survives only as the curated team-dispatch subset referencing the shared definitions.
- The `docs/agent-team/` vocabulary is deprecated in agent prompts; existing **Canvas Team Templates** or saved boards that referenced it keep working but no longer match the default agents' language.
