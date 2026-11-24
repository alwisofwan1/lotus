# Swarm Teams are a global catalog, not project-scoped

## Status

Superseded by ADR-0036 (modul CodeSwarm dihapus, 2026-09-19)

## Context

A **Swarm Team** is a reusable composition of **Swarm Agents** (`lead` +
`specialist` members). The user wants teams to behave like general / built-in
presets — assembled once and reused across every project — rather than being
re-created per project.

The current implementation is inconsistent with the rest of the catalog:

- **Swarm Agents** (`AgentDefinition`) are already a global, app-level catalog
  (`ensureDefaultAgents` seeds built-ins; shared by Canvas Settings and Swarm).
- **Swarm Workflows** are an explicit **global catalog** (ADR-0016); only a
  **Workflow Run** is scoped to the active project.
- **Swarm Teams** were the odd one out: storage is global
  (`~/.claude/teams/{id}/config.json`), but `AddTeamModal` stamped
  `projectDir: project.rootDir` onto each new team and `useSwarmTeams` filtered
  the list to `!projectDir || projectDir === activeProject` — making custom
  teams effectively single-project.

Crucially, `team.projectDir` was never load-bearing at execution time: the
**Team Terminal Launch** controller reads `rootDir` from the active CodeCanvas
project (and errors if none is open), not from the team. So `projectDir` on the
team was dead weight that only drove list filtering.

## Decision

- A **Swarm Team** is a **global catalog item**, visible in every project. It
  carries no project binding.
- **Stop stamping `projectDir`** on newly created teams; **stop filtering**
  teams by active project in `useSwarmTeams`.
- Project scope is supplied **only at execution time** — a **Team Terminal
  Launch** and a **Workflow Run** read the active CodeCanvas project root.
- The `AddTeamModal` exposes **no scope control**; the Teams surface has **no
  project filter**. The canonical Team shape at the UI layer is
  `{ name, objective, members[], defaultWorkflowId? }`.
- `TeamConfig.project_dir` (Rust) is retained as an **optional legacy field**
  for backward compat; it is read-tolerant but no longer written or used for
  scoping. Existing project-stamped teams surface everywhere going forward.

## Consequences

- Consistent catalog model across Agents, Teams, and Workflows: definitions are
  global; only runs/launches are project-scoped.
- No mandatory data migration — legacy teams with `projectDir` set simply stop
  being filtered out (they were already visible in their origin project).
- The Teams filter bar loses any project dimension; status + objective/preset
  filters remain.
- A future "pin team to project" / favorites affordance, if ever wanted, must be
  introduced as an **explicit per-project preference**, not by reviving
  `team.projectDir` as a scoping key.
- `Team Objective` is the canonical UI field name; it persists onto
  `TeamConfig.description` for compatibility (see CONTEXT.md).
