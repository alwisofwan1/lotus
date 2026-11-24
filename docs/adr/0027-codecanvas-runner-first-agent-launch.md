# 0027 — CodeCanvas agent launch is runner-first (CNVS-style); persona catalog stays Swarm-only

- **Status:** Implemented
- **Date:** 2026-06-28
- **Related:** ADR-0024 (live terminal personas), ADR-0025 (Agent Runtime Kernel), ADR-0017 (AgentDefinition = global Swarm catalog), ADR-0026 (CodeCanvas standalone ADE, Swarm optional consumer)
- **Decided via:** grilling session 2026-06-28 (this ADR records the answers)

## Context

CodeCanvas launches canvas agents **persona-first**: the "Add Agent" menu lists
pre-authored `AgentDefinition` personas (Ops/SRE, Support Engineer, Critic, Product
Manager…), each baking a role, system-prompt, model, and skills. The user wants the
[cnvs.dev](https://cnvs.dev) model instead: **runner-first** — you just launch a CLI
(`claude`, `codex`, `cursor`, a `ccs`/`csp` profile), and that *is* the agent.

The landmine: `AgentDefinition` is **not** CodeCanvas-local. It is the **global Swarm
Agent catalog** (ADR-0017), referenced by ~55 files across both modules — Swarm teams,
workflows, dashboard, agents surface — plus the CodeCanvas live-agent runtime (ADR-0024),
handoff-by-name, task dispatch, skills, and the Slice-6 persona colour. So "delete agents"
cannot mean deleting `AgentDefinition`; that detonates Swarm.

Decoding CNVS (Settings → Agents) shows **two layers** the persona model conflates:
1. **Installed CLIs** — a global registry of *which CLI tools exist and how they launch*
   (skip-permissions, extra flags, resume-on-reopen). No roles, prompts, or models.
2. **Named instances on the canvas** (Chase, Rubble…) — a launched CLI given a *name*, with
   no pre-authored role/prompt/model. Identity/role emerge from what you type in the terminal.

## Decision

Flip CodeCanvas's launch entry point from persona-first to **runner-first**. Scope is
**CodeCanvas-only**; Swarm is untouched.

1. **Runner Registry ("Installed CLIs").** A new global, app-level config (not per-project):
   the set of available **Runners** + per-runner launch config (skip-permissions, extra
   flags, resume-on-reopen). **Auto-detected** via a "Rescan" that scans `PATH` for known
   CLI binaries. This *replaces* the CodeCanvas Settings → Agents persona editor
   (`AgentsTab`/`AgentEditorModal` leave CodeCanvas; Swarm keeps its own agents surface).
   Mirrors how CNVS handles it (global + Rescan + resume).

2. **Runner-first launch.** The canvas "Add Agent" menu lists **Runners** (`claude`,
   `codex`, `cursor`, `ccs`/`csp`, `custom`), not personas. Launch spawns a **Live Agent**.

3. **Live Agent is CNVS-pure.** A launched runner = a live PTY with:
   - a unique **name** (auto-assigned from the name-pool, editable) — required for MCP
     cross-agent addressing;
   - an optional **colour** (Slice 6, editable inline);
   - **no baked role/system-prompt and no per-agent model.** The spawn spec drops
     `--append-system-prompt` and `--model`; role emerges from terminal input, model from the
     CLI default / `/model`.

4. **Cross-agent comms unchanged.** Live agents still register in `canvas_fleet` and
   coordinate via the existing fleet/handoff/Context-Bus MCP tools (ADR-0024, Fase 2),
   name-addressed. No new shared-memory mechanism.

5. **Skills node — re-pointed.** Since there is no baked prompt to inject into, a Skills node
   **dispatches the skill text into the agent's terminal** (same path as a normal dispatch),
   rather than composing a system-prompt.

6. **Team — re-pointed.** A Team becomes a **saved launch-set** (spawn N runners at once,
   e.g. `[claude, claude, codex]`), with no roles. Not a set of personas.

7. **Task dispatch — re-pointed.** Spawns a runner and auto-submits the task text, targeting
   a live agent by name. No persona selection.

8. **Resume-on-reopen.** Store a **session id per live-agent node**; on reopen, relaunch with
   the runner's resume flag (`claude --resume <id>`, etc.). Per-runner resume flag lives in
   the registry. (Bridge `session-store.ts` is the precedent.)

9. **`cursor` runner added** to `AgentRunnerType` + `resolveRunnerCommand` (the shared Agent
   Runtime Kernel, ADR-0025). `resolveRunnerCommand` is extended with extra-flags. Additive —
   Swarm is unaffected.

10. **`AgentDefinition` (Swarm persona catalog) is UNCHANGED.** Swarm teams/workflows/
    dashboard keep authoring rich personas. The two models coexist per ADR-0026 (CodeCanvas
    standalone ADE; Swarm an optional consumer).

11. **Migration.** Existing snapshots whose agent nodes carry persona fields load as live
    runners using the **cached `runner`** field; role/prompt/model are ignored at spawn. Zero
    data loss, no codec rewrite required.

## Consequences

**Positive**
- Launch is simple and CNVS-parity: pick a CLI, it runs. Lowest cognitive load.
- No persona authoring needed on the canvas; the rich catalog stays where it's used (Swarm).
- Reuses the live-agent runtime, fleet, handoff, kernel, name-pool, Slice-6 colour — small
  blast radius, all CodeCanvas-local.
- `AgentDefinition`/Swarm untouched → no 55-file detonation.

**Negative / risks**
- Two agent models in the repo (runner-first canvas vs persona Swarm). Accepted: ADR-0026
  already frames CodeCanvas and Swarm as separate surfaces.
- Skills-as-dispatch is weaker than baked skills (no prompt-time guarantee). Acceptable for
  the CNVS-pure model; revisit if needed.
- `cursor`/extra-flags/resume touch the shared kernel — must stay additive and keep Swarm
  runner/readiness tests green (ADR-0025 invariant).

**Domain language (CONTEXT.md)**
- **Runner**, **Runner Registry / Installed CLI**, **Runner-first launch**, **Live Agent
  (runner-first)** added; **Agent Persona** clarified as Swarm-only in the CodeCanvas context.

## Amendment (2026-06-30, ADR-0030)

Decision 3 ("the spawn spec drops `--append-system-prompt`… role emerges from terminal input") is
narrowed: a bare launch stays persona-free, but claude-family live spawns may carry a **tiny
out-of-band peer-messaging capability line** in the system prompt — opt-in via
`includePeerCapability` (the canvas sets it). This is *infrastructure/tool-awareness*, not a persona
(no role/model/skills), and is the documented home for tool-usage policy. `buildLiveAgentSpawnSpec`
remains CNVS-pure by default; the capability is additive. See ADR-0030.

## Implementation status (2026-06-28)

All decisions shipped on `feat/codecanvas-nl-arrange`. Phase numbers below map to the decision points above.

| Phase | Scope | Status |
|---|---|---|
| P1 | `cursor` runner + `extraFlags` in the Agent Runtime Kernel (decision 9) | ✅ |
| P2 | Runner Registry — `~/.lotus/runners.json` (`runners.rs`), per-runner config CRUD (decision 1) | ✅ |
| P3 | Settings → **Runners** tab (skip-permissions, extra flags, resume toggle) (decision 1) | ✅ |
| P4 | Runner-first launch — ⌘K spawns a CNVS-pure Live Agent (decisions 2–4) | ✅ |
| P5 | Resume-on-reopen (decision 8) | ✅ **E2E-verified** |
| P6a | Skills → dispatch into the agent terminal, not a baked prompt (decision 5) | ✅ |
| P6b | Task dispatch → runner-first (pick a runner, not a persona) (decision 7) | ✅ |
| P6c | Team → runner launch-set, spawn N runners at once (decision 6) | ✅ |
| P7 | Migration — old persona nodes launch bare via cached `runner` (decision 11) | ✅ (automatic) |

**P5 resume — final design (revised from the original).** Pre-minting `claude --session-id <uuid>`
was tried first but Claude Code ignores it and writes its own id, so `--resume` failed ("no
conversation found"). Shipped design instead: launch bare, **capture** the real session id from
`~/.claude/projects/<slug>/` (newest-vs-baseline delta), persist it on the node, and `--resume
<captured>` on reopen. Per-runner resume flag lives in the kernel; only Claude-family runners resume
today (codex uses a `resume` subcommand — deferred; cursor unverified). Hardened with a bounded
capture poll and a graceful fallback (stale id → relaunch bare once). Per-runner **resume toggle**
in Settings (default on). "Reopen" = reload the project with the node still on canvas — closing the
node deletes it.

**P6a skills — runner-aware, insert-not-submit.** A dropped skill is *inserted* into the live agent's
prompt (not auto-submitted), so the user adds context then presses Enter. Claude family gets the
native `/skill-name`; any other runner gets a `Read and apply the skill at <SKILL.md path>` reference
using the skill's absolute path (project AND global skills resolve regardless of the agent cwd).

**Known follow-ups (not blocking):** the Task node's "Agent Team" button still dispatches the
`ENGINEERING_TEAM` personas (the Team *node* is runner-first; this button is a separate path — a
product call on whether to retire/re-point it). Codex/Cursor native skill commands (if any) can be
added as branches in `formatSkillForRunner`.
