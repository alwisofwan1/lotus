# Swarm Workflow evolves Canvas Team Template in place (schema v3)

## Status

Superseded by ADR-0036 (modul CodeSwarm dihapus, 2026-09-19)

## Context

The Swarm Command Center needs a production **Workflows** surface (list, templates,
run, telemetry) aligned with mockup `plans/swarm-command-center/refs/05-workflows.png`.

Two persistence models were considered:

**Separate workflow store** — new `~/.lotus/workflows/` records distinct from
`~/.lotus/canvas-templates/`. Workflow would reference a template by ID. Risk: two
sources of truth for graph topology (drift between template and workflow copy).

**Evolve Canvas Team Template in place** — rename the domain term to **Swarm
Workflow**, bump schema to v3, keep the existing Tauri module and directory. Add
management fields (status, trigger, `sourceTemplateId`) and link runs via
`GraphRunRecord.workflowId`.

The graph-native model was chosen: a **Swarm Workflow** *is* the graph definition,
not a separate step DSL. CodeCanvas remains the editor and harness; Swarm manages
the catalog and run entry points.

## Decision

- **Swarm Workflow** replaces **Canvas Team Template** as the user-facing domain term.
- Persist at **`~/.lotus/canvas-templates/{id}.json`** (path unchanged for backward
  compat; ADR-0007 still applies).
- **Schema v3** extends v2 with: `status`, `trigger`, optional `sourceTemplateId`;
  `category: "builtin" | "user" | "imported"` unchanged.
- **Global catalog** — definitions are not scoped to a single project; **Workflow
  Run** execution is scoped to the active CodeCanvas project.
- **Templates tab** = workflows where `category === "builtin"`; user edits via
  **Clone Workflow** only (builtins are read-only).
- **Run Workflow** from Swarm: apply graph to active project (replace with confirm
  if canvas non-empty) → navigate to CodeCanvas → auto-start harness.
- **GraphRunRecord** gains optional `workflowId` for honest telemetry.

## Consequences

- One SSOT for graph definitions; Save-as-Template in CodeCanvas continues to write
  the same store (as `category: "user"`).
- Read v1/v2 on load; write v3. No mandatory directory migration.
- Swarm Workflows surface owns list/templates/run UX; CodeCanvas owns edit + harness.
- Manual/Human Approval gate nodes, schedule triggers, headless runs, and Activity
  audit feed are explicitly post-V1.
- Teams may set `defaultWorkflowId` in V1 (link only; no auto-run on team launch).
