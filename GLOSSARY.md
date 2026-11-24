# Lotus CodeCanvas + CodeSpace

Lotus CodeSpace is a workspace for coordinating local editor context, terminal cells, and headless planning agents through the Bridge interface.

> **Note on `lotus-remote` in this glossary (2026-08-02).** The directory `lotus-remote/` was renamed
> to `packages/host/` in the meta-repo restructure. The term "lotus-remote" still appears below as
> *domain vocabulary*, and that vocabulary was deliberately left alone: renaming a canonical term is a
> domain-modeling decision, not a path fix. Once the Telegram adapter is removed
> (`plans/lotus-pocket/` ADR-2), this glossary needs a pass to settle the canonical name for that
> layer — likely **Host Layer** — alongside the already-planned "Bot Operator" → "Device Operator"
> rename. Until then, read "lotus-remote" as the host layer, wherever it lives on disk.

## Language

**Bridge Command**:
A slash-menu entry in the Bridge composer that either runs locally or rewrites the prompt sent to a planner.
_Avoid_: Slash item, slash option

**Bridge Skill**:
A Bridge Command that rewrites the submitted prompt into an instruction to use a named skill.
_Avoid_: Skill command, prompt macro

**Bridge Action**:
A Bridge Command that changes local Bridge state without sending a prompt to a planner.
_Avoid_: Local command, UI command

**Fleet Command**:
A Bridge Command that routes work to one or more workspace cells.
_Avoid_: Cell command, agent routing command

**Browser Pane Runtime**:
The CodeSpace module that owns native browser pane lifecycle: URL normalization, host bounds sync, visibility, navigation commands, and disposal policy.
_Avoid_: Webview hook, resize hook

**Browser Annotation Contract**:
The CodeSpace module that owns browser annotation event parsing, payload sanitization, webview-label filtering, and AI-context formatting.
_Avoid_: Annotation JSON cast, annotation formatter helper

**Browser Annotation Router**:
The CodeSpace module that owns annotation target derivation, terminal routing, spawned-pane pending delivery, and Claude prompt readiness handling.
_Avoid_: Annotation route callback, pending annotation map

**Command Category**:
A functional group used to organize Bridge Commands by intent, such as **Engineering**, **Design**, **Research & Docs**, **QA**, **Integrations**, or **Productivity**.
_Avoid_: Source, install location

**Rich Markdown Note**:
A CodeCanvas note for authoring formatted, agent-readable context with Markdown as its canonical content.
_Avoid_: HTML Note, WYSIWYG Note

**Note Asset**:
A durable file embedded in a **Rich Markdown Note** and referenced from its Markdown content.
_Avoid_: Ephemeral attachment, runtime attachment

## Relationships

- A **Bridge Command** belongs to exactly one **Command Category**
- A **Rich Markdown Note** can reference zero or more **Note Assets**
- A **Rich Markdown Note** can supply its Markdown content and **Note Assets** as agent context
- A **Bridge Skill**, **Bridge Action**, and **Fleet Command** are kinds of **Bridge Command**
- A **Fleet Command** targets workspace cells; a **Bridge Skill** targets the planner prompt
- A **Browser Pane Runtime** can back a grid Browser pane, the right-panel Browser, or a Workbench URL tab
- A **Browser Annotation Contract** receives annotation payloads emitted from a **Browser Pane Runtime** native webview
- A **Browser Annotation Router** routes context produced by a **Browser Annotation Contract** to terminal cells or newly spawned cells

## Example dialogue

> **Dev:** "Should `/theme-factory` live under User Skills because it came from `~/.agents/skills`?"
> **Domain expert:** "No — its **Command Category** is **Design**. Install location is secondary metadata, not the primary grouping."

**Canvas Browser Node**:
A CodeCanvas node backed by a Tauri native WebView. Displays a live URL, supports browser annotation (click-to-annotate with screenshot back-channel), and is spawned either by the user (manual) or by a running agent via the **Canvas Agent API**. Exactly one Canvas Browser Node may be active per **Canvas Terminal Node** at a time.
_Avoid_: WebView node, browser tile, browser pane (that term belongs to CodeSpace)

**Canvas Browser Control**:
The CodeCanvas module that resolves browser intents against the current canvas graph and turns them into one deterministic plan: spawn a **Canvas Browser Node**, focus an existing one, activate a disconnected one, or navigate the native WebView. It preserves the one-to-one **Canvas Terminal Node** to **Canvas Browser Node** rule across human commands, NL commands, and **Canvas Agent API** events.
_Avoid_: browser toggle logic, browser command helper, browser event handler

**Canvas Browser Snapshot And Search**:
The CodeCanvas module that lets a running agent inspect the active **Canvas Browser Node** without full browser automation. It captures a bounded DOM/text/control snapshot and query-ranked page search results through the **Canvas Agent API**, so agents can find page data, links, and controls before asking for Playwright-style automation.
_Avoid_: screenshot endpoint, page scrape helper, browser search script

**Canvas Agent API**:
The HTTP API layer (routes on the existing axum server) that canvas PTY sessions can call to interact with the canvas. Accessible via the `AGENT_CANVAS_API` environment variable injected at PTY spawn time. Enables agents to open browsers, navigate, and pull screenshots without modifying their PTY output.
_Avoid_: Canvas API server, agent canvas endpoint, MCP canvas bridge

**Canvas Terminal ID**:
The ReactFlow node ID of a **Canvas Terminal Node**, injected as `AGENT_CANVAS_TERMINAL_ID` into its PTY session at spawn time. Used by the **Canvas Agent API** to route browser spawn requests back to the correct terminal on the canvas.
_Avoid_: PTY session ID, pane ID, terminal session ID

**Browser Spawn Edge**:
The dashed ReactFlow edge that connects a **Canvas Terminal Node** to its **Canvas Browser Node**. Carries three functional roles: ownership (browser closes when terminal closes), navigation control (agent navigates via API), and annotation back-channel (screenshots delivered from browser to terminal). Not purely decorative.
_Avoid_: Dashed edge, browser connection, browser link

**File Node**:
A CodeCanvas node that shows one project file read-only and live (Shiki highlighting, git marks beside the line numbers, updated as the file changes on disk). It stores the path only, never the contents. It is for looking at a file beside the agent working on it; editing happens in **Code (Dock app)** (⏎ or the Edit button). A **File Node** wired to a **Canvas Terminal Node** is a `context` wire: the agent is handed the path, not the contents. Its chip names the live agent that most recently touched the file, with +/− lines.
_Avoid_: file viewer, editor node, code node

**Code (Dock app)**:
The Canvas Dock app that edits project files: CodeSpace's Workbench editor at 100% scale on the shared Workbench session (tabs, dirty state, save, "changed on disk" banner). Its left column is "Changed by this board" (files this board's agents touched) plus ⌘P, not a file tree. "Show on board" closes the Dock and reveals the file's **File Node**; see ADR-0061.
_Avoid_: Canvas editor, Monaco node

**Canvas Snapshot Codec**:
The CodeCanvas module that validates, repairs, and migrates persisted canvas snapshots before they hydrate into ReactFlow. It accepts schema-versioned raw snapshot data, quarantines unknown nodes, drops invalid wires, normalizes unsafe geometry, and returns repair records for observability.
_Avoid_: snapshot parser, JSON cast, migration helper

**Canvas Browser Annotation**:
A CodeCanvas-scoped annotation contract for **Canvas Browser Node**: user or agent marks a region → screenshot is captured → delivered to the connected **Canvas Terminal Node** as an image attachment. Shares no runtime code with the CodeSpace **Browser Annotation Contract** to avoid cross-module coupling.
_Avoid_: Browser annotation (ambiguous with the CodeSpace term), annotation callback

**Task**:
A persistent work item scoped to a Project (via workspace_id = rootDir) and optionally to a Team. Backed by `BridgeTask` (workspace-scoped JSON store). Managed by humans and AI agents alike. Not a one-shot Claude CLI invocation — a Task persists across agent runs.
_Avoid_: TaskFile (legacy team-scoped model), task run, agent job

**SubTask**:
A flat checklist item within a Task. Has its own `status: pending | in-progress | completed`. Progress percentage on the parent Task is derived from SubTask completion ratio. SubTasks are not independently assignable in V1.
_Avoid_: nested task, child task, sub-issue

**Task Intake**:
The mandatory understanding phase before a director agent assigns a **Task** to team members. The Director clarifies objective, scope, assumptions, acceptance criteria, risks, and evidence needs, then decides whether the task can proceed to assignment or requires Human input first.
_Avoid_: preflight, planning step, initial prompt

**Task Understanding Brief**:
The concise artifact produced by the **Task Intake** that states the Director's current understanding of a **Task** before assignment. It records the task objective, scope boundaries, assumptions, acceptance criteria, unresolved questions, and recommended execution shape.
_Avoid_: plan, summary, task analysis

**HITL Grilling**:
A Human-in-the-loop clarification exchange used when the **Task Intake** finds ambiguity or high risk. The Director asks one focused question at a time, gives its recommended answer, and incorporates the Human's answer before proceeding.
_Avoid_: clarification chat, approval prompt, user feedback

**Task Workspace**:
The stable project scope for **Tasks**, derived from the active CodeCanvas project root. All teams within the same project share one Task Workspace.
_Avoid_: task namespace, task scope key

**Task Assignee**:
An agent name from the assigned Team's member list. A Task supports multiple assignees (`assignees: string[]`). An AI agent can self-assign by patching the task via IPC. Human users are not assignees in V1.
_Avoid_: owner, responsible party, human assignee

**Task Blocker**:
A structured reason a **Task** cannot safely proceed in its current phase. A blocker can come from intake ambiguity, missing Human input, authentication, dependency failure, verification failure, or system error. `blocked` is a lifecycle state; blocker type and phase explain why.
_Avoid_: needs-input status, error string, waiting state

## Relationships

- A **Canvas Terminal Node** spawns at most one **Canvas Browser Node** (one-to-one constraint)
- A **Browser Spawn Edge** connects exactly one **Canvas Terminal Node** to exactly one **Canvas Browser Node**
- A **Canvas Browser Node** is partially persisted: its URL is saved to the canvas snapshot, but its WebView is not auto-reconnected on restore (starts in "disconnected" state)
- **Canvas Browser Control** is the single semantic owner for open-or-focus and navigate behavior across human, NL, and agent-triggered browser intents
- **Canvas Browser Snapshot And Search** exposes bounded page inspection for the **Canvas Browser Node**; full click/fill automation remains an adapter concern such as Playwright MCP
- A **Canvas Agent API** call carrying a **Canvas Terminal ID** must resolve to a live **Canvas Terminal Node** on the current canvas
- A **Canvas Snapshot Codec** must process persisted snapshot data before ReactFlow hydration
- A **Canvas Browser Annotation** delivers a screenshot (not text) to the **Canvas Terminal Node** on the other end of the **Browser Spawn Edge**
- A **Canvas Browser Annotation** is independent of the CodeSpace **Browser Annotation Contract** — they share no types or runtime code

**Agent Runner**:
The CLI launch configuration on an agent specifying which agent binary and permission mode to use when spawning its PTY session. Supported built-in types: `claude` (→ `claude --dangerously-skip-permissions`), `ccs` (→ Claude Code profile `ccs`, YOLO), `csp` (→ Claude Code profile `csp`, YOLO), `codex` (→ `codex --full-auto`). Custom runners use a free-form command string. Stored as `runner` on `AgentDefinition` (TypeScript) and `TeamMember` (Rust).
_Avoid_: agent command, CLI type, agent binary, runner preset

**Agent Runner Readiness Adapter**:
The module that interprets PTY output for a specific **Agent Runner** and decides whether the runner is ready, still pending, or failed. Claude-family runners use Claude Code prompt signals such as `? for shortcuts`; Codex uses Codex prompt signals; startup failures such as `command not found` are reported before timeout. A session receives work only after its adapter reports ready.
_Avoid_: fixed startup delay, sleep-based readiness, ready timer

**Smart Convert**:
The AI-assisted flow that transforms a **Rich Markdown Note** into a **Canvas Task Node** in-place. Triggered by the "⚡ Smart Convert" footer button on the NoteNode. Opens a two-panel modal: original note read-only on the left, editable AI-drafted task structure on the right. On confirm, the NoteNode morphs into a TaskNode at the same position and ID — existing edges are preserved. Backed by a one-shot `claude --print --output-format text` invocation via the `smart_convert_note` Tauri command.
_Avoid_: note conversion, note-to-task, AI task creation

**Note Intent**:
The AI-clarified goal field on a Canvas Task Node produced by **Smart Convert**. Describes what must be achieved and why in 1–3 sentences. Displayed as a read-only paragraph instead of the raw description textarea when present. Stored as `intent` on `CanvasTaskNodeRecord`.
_Avoid_: description, goal (those belong to other node types)

**Task Class**:
A complexity/effort dimension on a Canvas Task Node. Values: `quick` (<2 h), `needs-research` (investigation required), `deep-focus` (>4 h), `benchmark` (measuring/comparing). Set by **Smart Convert** or manually. Rendered as a coloured chip in the TaskNode body.
_Avoid_: task type, effort level

**Task When**:
A scheduling dimension on a Canvas Task Node. Values: `urgent`, `this-week`, `this-month`, `whenever`. Set by **Smart Convert** or manually. Rendered alongside **Task Class** as a coloured chip. Surfaced in a **Task Dispatch Prompt** under the label "Timeline" (a presentation synonym, not a separate field).
_Avoid_: priority (that term is the existing `CanvasTaskPriority` = none/low/medium/high)

**Acceptance Criterion**:
A verifiable done-condition on a Canvas Task Node produced by **Smart Convert**. Rendered as an interactive checkbox list under CRITERIA. Stored as `acceptanceCriteria: AcceptanceCriterion[]` on `CanvasTaskNodeRecord`.
_Avoid_: checklist item, subtask (subtask = flat list inside BridgeTask, a different concept)

**Smart Convert Runner**:
The configurable AI backend for **Smart Convert**. Each runner has `id`, `label`, `models[]`, and `invoke(content, model)`. Default: `claude` runner via `smart_convert_note` Tauri command. Additional runners (Codex, local LLMs) added to `SMART_CONVERT_RUNNERS` in `smart-convert-runner.ts` without touching modal or morph logic.
_Avoid_: AI provider, LLM backend

**Task Dispatch Prompt**:
The canonical Markdown an agent receives from a **Canvas Task Node** — title, Timeline (**Task When**), **Note Intent**, **Acceptance Criteria**, and, when the task is backed by a **Task**, a **Task Completion Callback**. Emitted by all three node actions: Copy Prompt, Run in Terminal, and Agent Team. Run in Terminal and Agent Team append the agent's persona after a `---` rule; Copy Prompt omits the persona.
_Avoid_: task prompt string, prompt payload, Task Understanding Brief (a **Task Intake** artifact)

**Task Completion Callback**:
The `curl` instruction embedded at the foot of a **Task Dispatch Prompt** telling the agent to mark its **Task** ready for review on finish — `PATCH $AGENT_CANVAS_API/api/tasks/:id` with `{"status":"in-review"}` and a `Bearer $AGENT_CANVAS_API_KEY` header. Present only when the task carries a backend `taskId`.
_Avoid_: task update hook, manualReviewDone (no such field exists; the signal is the `in-review` status)

## Relationships

- A **Smart Convert** call produces exactly one **Canvas Task Node** that replaces the source **Rich Markdown Note** in-place (same ID, same position, edges preserved)
- A **Canvas Task Node** from **Smart Convert** carries **Note Intent**, **Acceptance Criteria**, **Task Class**, and **Task When** in addition to the standard task fields
- **Task Class** and **Task When** are independent — both are always set (defaulting to `quick` / `whenever` if the AI omits them)
- A **Smart Convert Runner** is selected per modal session; the user can switch models and re-roll before confirming

**Agent Definition**:
A reusable agent definition in the app-level global catalog (`AgentDefinition`), shared across every CodeCanvas project and surfaced in Canvas Settings. Carries `name`, `model`, `effort`, optional `role`, applied skills, permission mode, prompt, and an **Agent Runner**. Built-in agents are seeded once via `ensureDefaultAgents`. A Swarm Agent is a *definition* (template), not a running process — a live PTY is a separate runtime instance backed by this definition.
_Avoid_: agent instance, agent process, Member (a **Swarm** Member is a Chat thread, not a definition)

**Remote-Scoped Skill**:
An Agent Skill that is made available to an agent **only** when that agent is spawned by a remote-initiated session (Telegram/lotus-remote), and is never visible during a local desktop coding session. It exists to give the mobile operator extra capabilities without polluting the user's personal global skills or a project's committed skills. A Remote-Scoped Skill is a kind of Agent Skill distinguished purely by *when* it is in scope, not by its content.
_Avoid_: mobile skill, bot skill, lotus-remote plugin

**Remote Session Scope**:
The signal, carried on a remote agent spawn or chat request, that marks the resulting agent session as remote-initiated and therefore eligible for **Remote-Scoped Skills**. Each spawner resolves the scope to its own skill location; the scope is never an absolute filesystem path supplied over the wire.
_Avoid_: addDirs flag (implementation detail), remote flag, mobile mode

## Relationships

- A **Remote-Scoped Skill** is a kind of Agent Skill; it differs from a personal or project skill only by being in scope solely under **Remote Session Scope**
- **Remote Session Scope** is set only by remote adapters (e.g. Telegram via lotus-remote); a local desktop session never carries it, so local sessions never see **Remote-Scoped Skills**
- Both the desktop spawner (client mode) and the lotus-remote standalone host honour the same **Remote Session Scope** signal, each resolving it to its own skill location

**Standalone Orchestrator**:
The lotus-remote standalone host operating as an autonomous multi-agent orchestrator on a single host, with no Lotus desktop app present. It accepts goals submitted from a remote adapter (e.g. Telegram), coordinates worker agent sessions to completion, and persists task state durably — the headless counterpart to Lotus on the desktop.
_Avoid_: standalone mode (that is a deployment switch, not the role), VPS bot, remote host

**Headless Director**:
The agent-driven coordinator inside a **Standalone Orchestrator**. It is a long-lived, event-driven agent session that reasons over a goal, dispatches work to worker cells through tools, monitors them, and drives a task to completion — with no human terminal surface. Its orchestration logic lives in the model, prompt, and tool contract, not in bespoke code.
_Avoid_: orchestrator engine, director service, scheduler

**MCP-IPC Contract**:
The localhost HTTP tool surface (the `/v1/*` routes) that backs the Lotus MCP tools — fleet coordination (list/spawn/dispatch/read/wait) and task lifecycle (create/update/intake/assignment/result/review/complete). Both the desktop app and the **Standalone Orchestrator** implement the *same* contract, so one MCP sidecar and one **Headless Director** prompt drive either backend unchanged. Contract parity — not shared orchestration code — is what prevents two sources of truth.
_Avoid_: mcp_ipc.rs (one implementation), fleet API, IPC server

**Managed Host**:
A Standalone Host that the Lotus desktop app installed on an SSH machine, for that machine's user and without root, and that it keeps at the app's own version. It exists only after the user agreed to install it; a host set up by hand is not a Managed Host, and the app leaves it alone.
_Avoid_: remote host, auto host, server

## Relationships

- A **Standalone Orchestrator** hosts exactly one **Headless Director**
- A **Headless Director** has no terminal surface — it drives work entirely through the **MCP-IPC Contract**
- A **Headless Director** shares the orchestration prompt and the **MCP-IPC Contract** with the desktop app; it duplicates no orchestration code
- The **MCP-IPC Contract** is implemented by both the desktop app and the **Standalone Orchestrator** (contract parity); the same MCP sidecar talks to either by reading a different discovery file (port + secret)
- A **Headless Director** is invoked event-driven (a remote-submitted goal, a worker-idle notification, or — later — a scheduled tick), never as a perpetually-running reasoning loop
- A **Standalone Orchestrator** persists **Task** state in a local file store; it requires no desktop app and no database
- A **Managed Host** is never a requirement: an SSH workspace works the same without one, and the app only offers it
- A **Managed Host** keeps running sessions through an update
- A **Headless Director** runs on an **Agent Runner** (claude or codex) and is provider-portable; the runtime is chosen per deployment, partly for cost/billing reasons, without changing the orchestration prompt or the **MCP-IPC Contract**

**Canvas Agent Node**:
A CodeCanvas node backed by a reusable **Agent Definition** definition, carrying the agent's identity on the canvas: cached name/model/skills/governance, run history, and N2 handoff + N3 context-bus wiring. Has an **Agent Execution Mode**. It is the agent's presence on the graph — distinct from the **Canvas Terminal Node** (a bare PTY shell with no agent identity).
_Avoid_: agent card, agent tile, canvas agent (lowercase, ambiguous)

**Agent Execution Mode**:
The `executionMode: "headless" | "live"` field on a **Canvas Agent Node**. `live` (the canonical, default mode for new nodes) = a persistent interactive persona owning a **Live Agent Session** — the only mode under active development (CNVS-focused scope). `headless` = the pre-existing one-shot `agent_cli_run` worker (was `run_codechat`) that still backs Run Graph / Critic / Plan; it is **dormant** — kept working for old snapshots but not extended, and there is **no in-UI live↔headless toggle**. Snapshots predating the field load as `headless` so old boards are unchanged (ADR-0024).
_Avoid_: agent mode, run mode, live flag

**Live Agent Session**:
The persistent PTY runtime instance owned by a **Canvas Agent Node** whose **Agent Execution Mode** is `live`. Spawned through the **Agent Runtime Kernel** (provider-portable via **Agent Runner**, with readiness tracked by the **Agent Runner Readiness Adapter**), registered into the canvas fleet, and therefore dispatchable and handoff-able by other agents. It retains its **Canvas Agent Node**'s agent identity (definition, skills, N2/N3 wiring) — that identity is what makes cross-agent handoff meaningful.
_Avoid_: agent terminal, live terminal, promoted terminal (the one-way promote escape hatch is superseded), agent PTY

**Agent Persona Identity**:
The coordination identity of a **Canvas Agent Node**: a human-friendly, person-style `name` (e.g. "Skye", "Rex") plus a visual marker (color / avatar initial), layered on the **Agent Definition** definition's existing `name`, `role`, and `prompt` (which already carry the agent's character). Edited in Canvas Settings (the agent catalog), surfaced prominently on the **Live Agent Session** header. The `name` is the **addressing handle** an orchestrator or peer agent uses for cross-agent read/handoff (`read_terminal({target:"Skye"})`); it is resolved internally to the agent's stable `id`, and must be **unique per canvas** (enforced on create/rename) so that resolution is unambiguous — all wiring (handoff, fleet, edges) keys on `id`, never the free-text name. It adds a visual/identity layer only — no separate personality field that would overlap with `role`/`prompt`. **Superseded for CodeCanvas launch by ADR-0027**: a **Runner-first launch** Live Agent keeps only the `name` (+ optional colour) as identity — `role`/`prompt`/`model` are not baked; the full persona identity (catalog-authored) remains a **Swarm** concept.
_Avoid_: agent avatar, persona prompt, character field

**Agent Handle**:
The person-style name an agent is called by ("Nara"), in Canvas, Code and Chat alike, by typing or by voice. It is given once, from the active **Name Pool**, and never changes by itself afterwards; only a user rename changes it.
_Avoid_: agent name (ambiguous with the runner/provider name "Claude"), display name, nickname

**Name Pool**:
A named list of names that new **Agent Handles** are drawn from at random. Lotus ships a few, one per language (Neutral, 日本語, Bahasa Indonesia); a user can add their own. One pool is active for the whole app, or "Auto" follows the device language.
_Avoid_: naming language, name roster, name theme

**Agent Runtime Kernel**:
The module-neutral home of the **Agent Runner** (`resolveRunnerCommand`, provider-portable across claude/codex/ccs/csp/custom) and the **Agent Runner Readiness Adapter**. Depended on by **Canvas Agent Node** live mode and any other surface that spawns an agent CLI; no surface owns it (ADR-0025).
_Avoid_: swarm runner module, agent launcher, runner util

**Runner**:
A launchable CLI an agent runs on: `claude`, `codex`, `cursor`, a `ccs`/`csp` profile, or `custom` (an arbitrary command). The `AgentRunnerType` resolved to a command string by the **Agent Runtime Kernel** (`resolveRunnerCommand`). A Runner has no role, prompt, or model of its own — it is just the tool.
_Avoid_: engine, provider, model (a model is selected inside the CLI, not by the Runner)

**Runner Registry** (a.k.a. **Installed CLIs**):
The global, app-level config of which **Runner**s are available and how each launches: skip-permissions, extra flags, and resume-on-reopen. Auto-detected by scanning `PATH` ("Rescan"). It is CodeCanvas's launch source (Settings → Agents) — it **replaces** the persona editor there; the **Agent Definition** catalog is separate (ADR-0027). Distinct from the **Agent Definition** catalog: the Registry is tools, the catalog is personas.
_Avoid_: agent catalog, installed agents, runner list

**Runner-first launch**:
CodeCanvas's CNVS-style launch model (ADR-0027): the canvas "Add Agent" menu offers **Runner**s, not personas. Launching spawns a CNVS-pure **Live Agent Session** — a live PTY with a unique **name** (for MCP addressing) and optional colour, but **no baked role/system-prompt and no per-agent model** (role emerges from terminal input; model from the CLI default / `/model`). Cross-agent comms (fleet, handoff, Context Bus) are unchanged. The persona-first catalog launch is superseded in CodeCanvas.
_Avoid_: persona launch, agent template launch (the superseded model)

## Relationships

- A **Canvas Agent Node** is instantiated from a **Agent Definition** definition and caches its config (so it stays runnable if the definition changes)
- A **Canvas Agent Node** created today is always `live`; `headless` exists only for old snapshots and the dormant Run Graph path — there is no UI toggle between the two in the current scope
- A **Canvas Agent Node** in `live` mode owns exactly one **Live Agent Session**; in `headless` mode it owns none
- A **Canvas Agent Node** carries an **Agent Persona Identity** (person-style name + visual color/avatar) surfaced on its **Live Agent Session** header and used as the cross-agent coordination handle
- An **Agent Persona Identity** `name` is unique per canvas and resolves to a stable `id`; cross-agent addressing (`read_terminal({target})`, dispatch) uses the name for ergonomics but every persisted reference keys on `id`
- A **Live Agent Session** coordinates with peers primarily through the Lotus **MCP tools** (`lotus_read_cell_output`, `lotus_dispatch_to_cell`, `lotus_wait_cell_idle`), which are native tool-calls backed by the **MCP-IPC Contract** (`/v1/*`); the **Canvas Agent API** HTTP endpoint is the provider-agnostic substrate and the fallback for runners that cannot load MCP (e.g. custom runners)
- Inter-agent coordination is MCP-primary, endpoint-substrate: MCP and the HTTP endpoint are not competing systems — the MCP sidecar is the typed tool front over the same `/v1/*` contract the endpoint exposes
- The agent handoff/coordination state is **backend-owned and durable**: tasks in **Task** (`bridge_tasks.rs`, per-workspace Mutex) and shared artifacts in the **Context Bus** (SQLite `codecanvas_artifacts`, versioned). A **Live Agent Session** writes/reads handoffs through MCP tools (`lotus_publish_handoff` / `lotus_read_handoffs`), NOT the frontend registry — the frontend registry write path only serves dormant headless canvas agents and cannot be reached from inside a PTY
- The optional filesystem `work/` layout (per-agent `tasks/` + shared `outputs/`) is a canonical durable projection for the **Standalone Orchestrator** (CLI-only, no canvas) and non-MCP runners; on desktop, Lotus projects it into the visual Context Bus rather than treating files as the source of truth
- Agent-initiated handoff is loop-guarded at the backend **MCP-IPC Contract** (the unbypassable choke point), not in the agent prompt: a handoff carries a lineage (agent-id chain + `depth`), and the backend refuses on hop-depth overrun or a repeated id (cycle). This is distinct from the Run Graph's `hasCycle()` DAG check, which only covers graph-scheduled runs
- Each **Task** carries a budget (max total handoff hops + max aggregate token/cost across its agents); exceeding it hard-stops dispatch at the backend. A tripped loop-guard or budget raises a **Task Blocker** of `kind: loop-guard` and escalates to a human-gate rather than silently stranding work
- `useCanvasCommandCenter` is the single canonical canvas-operation layer; both the **NL Command Bar** (in-process) and agent MCP calls (via `/v1/*` event round-trip) drive it — one operation layer, two front doors
- The **NL Command Bar** is a canvas-command interpreter (Tier 1: arrange/create/focus/spawn) plus single-shot dispatch to one named agent (Tier 1.5); multi-step goal orchestration (Tier 2) is the **Primary/Headless Director** pattern's job, not the command bar. It runs on a stateful Bridge session; safe ops auto-apply (with a visible tool-call trace) while destructive ops (close/delete/kill) require confirmation
- A **Voice Outcome** is what a finalized voice/typed transcript resolves to — `command` (run through the NL pipeline), `dictate` (deliver to a resolved agent), `transform` (rewrite the selected text in a focused note in place — Option D), `insert` (hold in the bar for review), or `ignore`. It supersedes the earlier two-value `VoiceMode` decision (`command` | `dictate`) in `voice-mode.ts`: instead of the user pre-selecting a mode, the outcome is inferred from the **Canvas Voice Context** plus the transcript. Resolved by the **Voice Intent Router** (`resolveVoiceOutcome`, pure). A `transform` reaches the note's Tiptap editor through the **note-selection registry** (`noteSelectionRegistry`) — the bar reads the selection and writes the rewrite back without importing the editor
- **Canvas Voice Context** is the structured snapshot the **Voice Intent Router** reads to infer a **Voice Outcome**: the **Focused Node** (kind + name), the selection count, the live fleet, short-term dialogue memory, and — for a focused note — its currently selected text (drives `transform`). (Not yet included: clipboard and the last agent output tail.) It is the native, ground-truth equivalent of SuperWhisper's accessibility-derived Super Mode context — Lotus owns it directly rather than probing the OS. Assembled by a pure builder from data already present at the command-bar call site (no new backend plumbing in v1)
- A **Focused Node** is the single selected canvas node (selection count === 1) — the anchor the **Voice Intent Router** uses to resolve context-relative targets ("close it", dictation target). Distinct from multi-selection and from focus-mode zoom
- **Conversational Repair** is the command bar's response to an ambiguous single target (Option C, ADR-0034): instead of a dead-end error, it asks *"Which one — A or B?"* with candidate chips and re-runs the pending intent on the user's pick. The candidates ride out through the single `nameError` chokepoint as an optional `clarify` on the error; `resolveNlIntents` enriches it (question + intents) only for a single-intent request; the pick re-runs via `resolveClarifiedIntents`, which filters the non-chosen candidates out of the pools so the name resolves uniquely. Multi-intent batches keep a plain error
- **Voice Auto Mode** is the default behaviour of the command bar: the **Voice Intent Router** infers the **Voice Outcome** from the **Canvas Voice Context** and the text. Precedence: an explicit canvas-command verb always resolves to `command` (even when an agent is the **Focused Node**); otherwise plain prose with an agent focused resolves to `dictate`. Routing runs **fast-path first** (zero model — `matchLocalIntent` for verbs, direct dictate for prose-to-focused-agent) and only escalates ambiguous/compound utterances to the Haiku planner. It governs **both** spoken input (mic) and **typed Enter** — typing prose with an agent focused dictates to it, honouring the predictive "→ Rowan" chip — so speaking and typing route identically. The word floor (`minWordsToSubmit`) is a voice-only guard against a stray short spoken word; typed input never holds for review. The ⌘⇧V (force `command`) and ⌘⇧D (force `dictate`) shortcuts are explicit overrides that bypass inference (ADR-0034)
- The **Agent Runtime Kernel** is owned by no surface; CodeCanvas depends on it as a shared kernel, not surface coupling
- A **Live Agent Session** registers into the canvas fleet (`canvas:<project>` workspace) as alive and dispatchable; a `headless` **Canvas Agent Node** does not
- Run Graph / Critic / Plan execution dispatches **Canvas Agent Nodes** in `headless` mode regardless of their default, to preserve checkpoint/replay determinism

- **Voice Output Settings** is the `output` block on the **TTS Provider Registry** (`~/.lotus/tts-providers.json`): `speakReplies`, `agentDoneAlert` (`voice` / `sound` / `off`; absent = read the legacy `agentDoneCallouts` switch), `wakeOnFinish`, `agentDoneCooldownMs`, and an optional `voiceId` override. It is voice config, not a global IDE preference, so it lives with the TTS registry — never in `~/.claude/settings.json` (ADR-0030)
- An **Agent-Done Callout** is a spoken announcement when a **Live Agent Session** finishes a *turn*. It is gated by `agentDoneCallouts` (background nodes) and extended to on-screen nodes by `wakeOnFinish` (visible nodes); `background` = node outside the viewport, `visible` = inside it (ADR-0030)
- An **Agent-Done Alert** is how Lotus tells you an agent finished a turn, in Canvas or Code: a spoken **Agent-Done Callout** (Voice), one batched chime (Sound), or nothing (Off). Chosen in Voice › How voice behaves; Voice with nothing able to speak plays the chime; the chime stays quiet while **Live Voice** is on. Triggered by the **Turn-Done Signal**, never **Session-Exit** (Lotus #184)
- A **Voice Card** is one of Listen, Speak or Live in Lotus Settings › Voice. Its light comes from real checks (the active engine, whether its key is stored, and the last **Voice Test** for that engine), never from settings alone. A cloud engine reads "Key saved" until a test passes. When something is wrong the card offers one fix. A **Voice Test** runs the real path: Listen records through Push-to-Talk speech-to-text, and Speak plays a line through the active voice (Lotus #180)
- The **Turn-Done Signal** (an agent finished a turn but is still alive) is derived from the PTY idle watcher (`useCellIdleWatcher` over `idle_ms`), preferring the semantic OSC 133 `is_shell_idle` when available. It is distinct from **Session-Exit** (the **PTY process** ended) — only Turn-Done drives callouts (ADR-0030)
- **Live Voice** is the speech-to-speech conversation mode (GPT Realtime or Grok): the user talks and the voice agent talks back and calls tools. It is a state of the composer, not a separate surface: while it runs, the composer's **Composer Target** reads Lotus and its conversation shows in a strip attached to the composer. It supersedes the earlier "Realtime is out of scope" line — Live Voice ships in CodeCanvas. Distinct from **Push-to-Talk**, where one spoken turn becomes text. The session is a pure reducer in `src/modules/voice-core/s2s-session.ts` (Lotus #179): an unexpected drop reconnects once, silently, with the same instructions and tools, and audio from the gap is never sent; a second failure shows the reason and Retry. Whether Live Voice is active is shared through the **Live Voice status** context (`voice-core/live-voice-status.tsx`), not a global flag
- **Push-to-Talk** is the single-turn voice input: the user holds or toggles the mic, the speech becomes text, and the text goes where the active **Voice Adapter** sends it. A spoken turn means exactly what typing that text and pressing Enter in the same composer would mean, in every mode; the mic has no meaning of its own. Hold and tap both work, and the listening row says which one is stopping the turn. A turn that becomes a command to Lotus runs at once (destructive ones still confirm); a turn that becomes a message to an agent becomes a **Held Prompt**, unless **Send Right Away** is on or the turn was ended with ⌘Enter. One turn at a time, run by the **Push-to-Talk session** (`src/modules/voice-core/push-to-talk-session.ts`, Lotus #177): a pure reducer that also guards typed submits, so two fast Enters run once; a new recording or Escape aborts the live turn, and its late result never applies
- **Send Right Away** is the one app-wide voice setting (off by default) that lets a spoken message to an agent go without being held for review, in every mode. ⌘Enter while listening does the same for one turn only. _Avoid_: auto-submit, dictate auto-submit
- A **Held Prompt** is spoken text waiting, unsent, in the target agent's own prompt (its Agent Node or pane). While one waits, Enter in an empty composer sends it and Escape clears it. The text waits in the composer instead when the composer already holds typed text, when focus moved during the turn, or when the agent cannot take unsent text. _Avoid_: review, dictation review
- The **Composer Target** is where pressing Enter in a composer would send the text right now, shown in the composer before anything is sent. A Push-to-Talk turn's target is fixed when the mic opens; if focus moves during the turn, the text waits in the composer with the reason instead of going to the new focus
- The **Voice Core** is the one voice engine shared by every mode: mic capture, speech-to-text, text-to-speech, the **Live Voice** session, the **Speaker Queue**, and barge-in. It knows nothing about canvas, chat, or code; the modes depend on it, never the reverse. Lives in `src/modules/voice-core/`; an architecture test fails if it imports a mode module
- The **Tauri Voice Port** is the one object that groups every voice call into Rust: speech-to-text (batch and stream), text-to-speech, the **Live Voice** stream, and the voice provider registries. The real port wraps `tauri-api`; tests use a fake port. **Voice Core** code calls Tauri only through it
- A **Voice Adapter** is what one mode plugs into the **Voice Core**: where a prompt goes, which targets exist, and which tools voice may call. One per mode — Canvas Voice Adapter, Code Voice Adapter, Chat Voice Adapter. `deliver` returns `sent`, `held` (text kept, with the reason) or `failed`; every adapter passes one contract suite (`src/modules/voice-core/voice-adapter.ts`, Lotus #181). _Avoid_: Voice Host (clashes with Standalone Host / `packages/host`), Voice Surface
- The **Code Voice Adapter** is Code mode's Voice Adapter. A Push-to-Talk turn waits in the composer for the user to check and send (default), or — with Voice › How voice behaves › "Send right away" on — goes where a typed Enter would: the focused terminal agent or thread. Text the focused pane cannot take stays in the composer with the reason. Its **Live Voice** tools act on the panes of the folder on screen: focus, say_to_agent, dispatch, spawn_agent, agent_status, read_agent_output, remember, recall; a message goes in as a typed Enter would. An agent is addressed by its handle (`agentName`, "Soren"), or by its title; a plain shell is not an agent, so no message is ever typed into it. A spoken close goes through `close_pane`, which first asks "Close Rowan?" and closes that one pane only on a yes, the way its × would, and never while an agent is working or waiting for the user; closing everything at once is refused (`src/modules/workspace-shell/services/code-voice-adapter.ts`, `code-live-voice-tools.ts`, Lotus #183)
- The **app voice hotkeys** are the Push-to-Talk key and the Live Voice key. They mean the same thing in every mode; the mode on screen claims them, and a mode without that action lets the key through and shows a short hint. Push-to-Talk is ⌥⇧Space by default; Live Voice is ⌘⇧L. Stored in `lotus-voice-hotkeys-v1`; voice settings use mode-neutral `lotus-voice-*` keys, carried over once from `canvas-voice-*` (`src/modules/voice-core/voice-hotkeys.ts`, Lotus #178). Canvas-only keys (⌘⇧V / ⌘⇧D) stay in the canvas hotkey registry
- The **Speaker Queue** is the single owner of spoken output. Priority, highest first: **Live Voice**, command reply, **Agent-Done Callout**, narration. While Live Voice is active, every lower voice stops and stays silent; a held callout may play after Live Voice ends — one line for all of them (names up to three agents, else a count). "Stop All Speech" (⌘K) silences every voice. One queue shared by every speaking surface; lives in `src/modules/voice-core/speaker-queue.ts` (Lotus #176). _Avoid_: "latest wins" speaker
- In Canvas, a spoken close runs as said (in Code it waits for a yes). Live Voice closes one node, all of a type, or everything with no confirmation. Push-to-Talk closes one node at once but asks for confirmation before closing several nodes or everything, until dictation stops truncating. The typed command bar asks for confirmation before closing everything

## Automation

**Automation**:
A saved, user-owned rule that starts agent work on its own: one **Automation Trigger** → one **Automation Action** → one or more **Automation Outputs**. Stored in `~/.lotus/automations.db`, executed by the `lotus-automation` Rust crate while the Lotus process is alive (window may be closed). Module-neutral: one service, surfaced from Chat and Code (sidebar, above Tasks) and from any mode via MCP (ADR-0038).
_Avoid_: workflow (that is **Graph Run**), routine, job, bot

**Automation Trigger**:
What starts an **Automation Run**. Kinds (registry): `slack_message` (message in a configured channel containing GitHub PR links and mentioning the user or a watched Slack user group), `slack_reaction` (the user's own 👀 reaction), `cron` (schedule + timezone), `manual` ("Run now"). A `pr_review` trigger may also turn on **Request Sources**. Events missed while Lotus was not running are caught up once on next start.

**Request Source**:
A place a `pr_review` is asked for that Lotus polls every few minutes instead of receiving events: today `github` (open, non-draft PRs that request the automation's account or an optional GitHub team `org/slug`). Turned on under the trigger's `config.sources.<key>`, beside whatever the trigger kind needs, so one review can be asked for from Slack and GitHub at once. Each request is acted on once while it stays listed; made again after it disappears (a re-request after a review), it counts as new. A new source (Notion, …) is one `RequestSource` handed to the poller (ADR-0041).
_Avoid_: event, hook, webhook (Lotus uses Slack Socket Mode, not webhooks)

**Automation Action**:
What an **Automation Run** does, chosen from a registry of kinds. MVP kinds: `pr_review` (GitHub-gated review producing a structured summary + line comments with a severity; runs **read-only**: read/search tools, `gh pr view|diff`, `git log|show`, and only the MCP tools on the automation's allow list — ADR-0039) and `agent_prompt` (the user's own prompt run through a delegation preset exactly as the user runs it, with every tool, skill and MCP server; may answer "nothing to report").
_Avoid_: step, task (that is a **Task** / tracker task), job

**Automation Output**:
Where an **Automation Run**'s result goes. Kinds: `draft`, `github_review`, `slack_thread`, `slack_dm_self`, `macos_notify`, and for `agent_prompt` the **Sheet Output** and **Drive Output**. Anything addressed to other people (GitHub, channel, thread) must pass through an **Automation Draft** and the user's "Kirim"; outputs addressed only to the user (a DM to self, the user's own Sheet and Drive) may be sent automatically.
_Avoid_: result, sink (implementation name of the trait)

**Google Connector**:
Lotus's own Google sign-in, one account per Lotus, shown in Connectors. Loopback + PKCE in the system browser, scope `drive.file` only, so Lotus can touch only files it made or the user picked. The refresh token sits in the same secret store as Slack's; no agent ever sees it (ADR-0044).
_Avoid_: Google integration, the claude.ai Google Drive connector (a different thing: it runs inside the agent)

**Sheet Output**:
An `agent_prompt` **Automation Output** that appends rows to one Google Sheet tab after each run. The automation names the columns; the agent returns `rows` with exactly those columns next to its `text`, and Lotus writes them. Made on save as a new sheet named after the automation unless a sheet Lotus made is chosen.
_Avoid_: export, sync

**Drive Output**:
An `agent_prompt` **Automation Output** that saves one file per run, `<automation name> — YYYY-MM-DD HH.MM` (the run's planned time, in the automation's time zone), in a Drive folder (default My Drive): the text as a Google Doc or Markdown, or the **Sheet Output**'s rows as CSV.
_Avoid_: upload, backup

**Automation Run**:
One execution of an **Automation Action** for one unit of work (e.g. one PR at one head SHA), identified by an idempotency key claimed atomically in the store. Carries status, retries, skip reason, and a step log. Runs started by an automation may never create, change, or delete automations (recursion guard).
_Avoid_: job, execution, attempt (an attempt is one retry inside a run)

**Automation Draft**:
The editable, not-yet-sent result of an **Automation Run**, reviewed in the Automation panel. Sending it fans out to the chosen **Automation Outputs**. A `pr_review` draft is marked stale when the PR's head SHA changes before it is sent. A `pr_review` draft is sent as a COMMENT review; only when it found nothing (no comment, nothing moved off the diff, verdict looks good) may the reviewer press Approve instead, and its Slack thread is told `LGTM ✅` (ADR-0042). The agent can never ask for an approval. A later review of a PR the automation already sent a review of, at a new head, is a **re-review**: it answers each earlier finding first (fixed, answered or not-fixed), raises new findings only near what changed since (blockers excepted), and can reply ✅ on the resolved GitHub threads (ADR-0043). The Slack reply's shape is the owner's, from `slack-reply` / `slack-reply-lgtm` blocks in the review instructions; a thread that asked for several PRs gets one message, shaped by a `slack-reply-group` block, and the reviewer may rewrite that message before it is posted (ADR-0052 §8).
_Avoid_: preview, pending review

**Automation Ask**:
The way an **Automation Run** of any action kind ends when the agent must stop for the user: one question, 0–4 choice labels, and a note box that is always offered. It waits first in the Inbox's "Waiting for you" list and counts in the badge until it is answered or dismissed. A run ends with either an Ask or a result/draft, never both (ADR-0040).
_Avoid_: needs-info, prompt, question card, blocker

**Automation Answer**:
The user's reply to an **Automation Ask**: the chosen label (if any) plus the note. Every choice, "Reject" included, starts a **Follow-up Run**; **Dismiss** closes the Ask without one.
_Avoid_: approval, response

**Follow-up Run**:
An **Automation Run** started by an **Automation Answer**. It resumes the asking run's own conversation (`--resume`) with the answer as the next message, using the preset, folder and project saved with that run — never the automation's current config — and the same action-kind rules and time limit. A `pr_review` follow-up stays read-only (ADR-0039). It may itself end with a new Ask, forming a chain shown together.
_Avoid_: retry, re-run, continuation

## Relationships

- An **Automation** has exactly one **Automation Trigger** and one **Automation Action**, and one or more **Automation Outputs**
- One trigger firing may produce several **Automation Runs** (one Slack message listing three PRs → three runs); the same idempotency key never produces a second run
- A `pr_review` **Automation Run** reviews whatever was asked for — the Review button, the user's 👀, a Slack mention of the user or their Slack user group, or a **Request Source** — so no GitHub review request is needed. GitHub still gates the PR itself: open, non-draft, not authored by the user, head unchanged while the run waited (ADR-0041)
- A team is named per place it is asked from: a Slack user group ID on the Slack trigger, a GitHub team slug on the `github` **Request Source** — the two systems name it independently
- Every **Automation** names a GitHub account (e.g. `alwisofwan1`); its token is resolved per run via `gh auth token --user` and never changes the terminal's active account
- An **Automation** is created by an agent through the `lotus_automation_create` MCP tool only after the user confirms a summary in chat
- An **Automation Ask** gets at most one **Automation Answer**; its idempotency key makes a double click start one **Follow-up Run**, even when the **Automation** is switched off
- A failed **Follow-up Run** keeps the **Automation Answer** and returns the **Automation Ask** to "Waiting for you" with "Send again"
- A **Sheet Output** or **Drive Output** needs the **Google Connector** connected when the **Automation** is saved; a write that fails never fails the **Automation Run** — it is kept as "not sent", and "Send again to Google" repeats only that write, never the agent (ADR-0044)

## Graph Run

**Run Node**:
A node on the canvas that is one **Graph Run**: it owns a set of member nodes (its scope), a budget cap, a timer and the decisions waiting on the user. Many Run Nodes can run at once on one board; a node belongs to at most one Run Node. Its status is read from the run, never typed in.
_Avoid_: run overlay, run screen

**Graph Run**:
One execution of the member nodes of a **Run Node**, in dependency order, stopping at a budget cap and resumable on its own after a restart.

**Factory Run**:
The kind of **Graph Run** Lotus is built around: one ticket from a **Ticket Source** taken to one **Factory PR**, through an isolated worktree, implementation, deterministic checks and review. Started by the user from a ticket, or by an **Automation**. It never merges; that stays the user's.
_Avoid_: pipeline, dark factory

**Factory PR**:
The pull request a **Factory Run** opens, labelled `factory:review`. Opened ready for review only when the review accepted the change and the checks are green, or the repo has none (ADR-0063); otherwise, or when the repo asks for it, opened as a draft (ADR-0055). Opened with a mandatory budget cap when an **Automation** started the run. Feedback on it belongs to the **Chief of Staff**, never to the PR-review Automation. Waiting for engineer review, being revised and out of rounds are states of the Factory PR, not of a run. Factory never force-pushes its branch (ADR-0057).
_Avoid_: Draft PR (it is not always a draft)

**Meta-repo**:
A git repo that holds other git repos side by side and keeps the rules for working in all of them, such as `acme-main`. A **Factory Run** started in one never changes it; it is where the run's rules and **Factory Workflow** come from (ADR-0063).
_Avoid_: monorepo (one repo, one history), parent repo, umbrella

**Sub-repo**:
A git repo one folder down inside a **Meta-repo**, with its own remote, such as `acme-api`. Triage picks the one a run builds in, and the user approves it with the **Spec**. A ticket that needs more than one stops the run in Needs you (ADR-0063, stage 1).
_Avoid_: member (a Graph Run's word), submodule, package

**Factory Workflow**:
A project's own shape for what a **Factory Run** hands back: branch name, commit message, PR title and body, base branch, and whether the **Factory PR** opens ready or as a draft. It shapes the output only; the steps of the run stay the same (ADR-0063).
_Avoid_: pipeline, process

**Revision Run**:
A **Factory Run** that revises an open **Factory PR** from its feedback: a new run linked to the PR, starting from the PR branch as it is on GitHub and adding commits on top. Each one is a round, with its own budget cap; a PR gets at most a few rounds before new feedback goes to the user (ADR-0057).
_Avoid_: revision stage, fix-up run, retry (Try again starts a fresh run for a failed one, not a round on a PR)

**Intake**:
The part of a **Factory Run** before any code: triage, then the spec agent's questions and the user's answers, until the user approves a **Spec**. Lotus caps neither the rounds nor the questions per round: the agent grills until it could build the ticket without guessing, and the run's budget cap bounds the cost (a repo may still set `max_questions` per round). Kept as turns on the run record, so it survives a restart; whose move it is follows from the last turn. Nothing approves a spec by waiting (ADR-0051).
_Avoid_: onboarding, planning phase

**Spec**:
What a **Factory Run** builds, approved by the user before implementation: goal, numbered acceptance criteria (`AC-1`, `AC-2`, …), out of scope, assumptions, test plan, files, optional design notes (UI flow, design decisions, data shapes) and **Clarifications**. Always rendered by Lotus from the same fields, whether the async spec agent or **Brainstorm live** wrote it, so the criteria are always numbered. An edit made while approving must keep at least one `AC-n` in its criteria section; one named elsewhere, such as in the design notes, is not a criterion, so an edit that names one only outside that section is refused rather than silently dropped. After the **Factory PR** opens, only the user can change it, by accepting a **Feedback Item** labelled spec-change; that adds an Amendment with new criteria rather than rewriting the approved ones.
_Avoid_: plan, PRD, requirements doc

**Feedback Item**:
One piece of feedback on a **Factory PR** that the **Chief of Staff** acts on: a human reviewer's comment, labelled change, nit, question, spec-change or none by what it asks for, or a failed CI check. Comments from bots and from people without write access never start a **Revision Run**. In a round each item ends addressed, not addressed or declined with a reason; a declined one goes to the user.
_Avoid_: finding, issue, comment (a comment labelled none is not an item to act on)

**Brainstorm live**:
The other way through **Intake**: the user grills the ticket with an agent in a terminal instead of answering question cards, and that agent saves a **Spec** onto the waiting run with `lotus_factory_save_spec`. Saving never starts the build. A round of questions it replaces before they were answered is marked as replaced and does not count as a round.
_Avoid_: live chat, interactive mode

**Chief of Staff**:
The agent that looks after **Factory Runs** from above: it watches runs that wait, stall or burn their budget, and carries a **Factory PR** through engineer review, reading the feedback and asking for a revision. It advises and requests actions; the Factory Run's own stages still decide what runs and in what order, and it never writes code itself. It acts by fixed rules: a model only judges one item at a time (labels a comment, drafts a reply) and never picks the action (ADR-0056). Not a stage of the run. Distinct from a **Headless Director**.
_Avoid_: foreman, director, supervisor, orchestrator

**Clarifications**:
The last section of a **Spec**: every question settled during **Intake** and its answer — the async rounds written by Lotus from the run's own turns, then the **Brainstorm live** session's under "Live session". A spec agent's reply cannot write any itself.

## Tasks and ticket sources

**Ticket Source**:
A project in the Tasks tracker whose rows come from outside Lotus: an Obsidian vault on this Mac (`kind: obsidian`, at most one), a Notion database (`kind: notion`, any number) or the issues of one GitHub repo (`kind: github`, any number; ADR-0048). Each brings its own status vocabulary and its own capabilities; the tracker asks "which kind of source" and never compares ids with the vault's. Listed in `~/.claude/settings.json` `ticketSources`; zero sources is the normal state (ADR-0045).
_Avoid_: vault project, integration, board (a Notion "board" is one view of a database, not the source)

**Source Health**:
The one state a **Ticket Source** is in after its last sync, said with the same words in the nav row, the list banner and Connectors: `healthy`, `offline`, `slowed_down` (a 429), `lost_access` (token gone, or the database not reachable), `fields_changed` (a mapped Notion property disappeared or changed type; every write stops), `failed`. While a sync runs the row says `syncing`, and before the first one `reading`. A source that is not healthy keeps showing its last good copy — it never empties the list (ADR-0045).
_Avoid_: sync error, connection status

**Manage**:
The permission a Notion **Ticket Source** can be given instead of the default **Read only**: Lotus may change a ticket's title, status, assignee, labels and body, move it to trash (with Undo), and create tickets and sub-tickets there. A property or body write is checked against what the person saw first (a property per field, the body as a whole), and every write is refused before any request on a Read only source — the token itself could write anywhere, so it is Lotus that keeps Read only read only (ADR-0045).
_Avoid_: write access, edit mode

**Read only**:
The default permission of a Notion **Ticket Source**, and the only one of a **GitHub Issue Source**: list, open and delegate; nothing is written to Notion. An agent delegated from a Notion ticket never writes to Notion, Manage or not (its Notion write tools are denied).

**Matched Note**:
The vault note that carries the same key as a Notion ticket (`TKT-1008` ↔ `TKT-1008.md`), shown as the "notes" badge and the ticket's Notes section. Only when the Notion source has "Match notes by key" on and a vault is connected; otherwise the feature leaves no trace (ADR-0045).
_Avoid_: linked ticket, synced note

**From Notion Section**:
The `## From Notion` section of a vault note: the one section Lotus writes, whole, when the human refreshes it from its Notion page (Review changes → Update the vault note). Every other section is the person's and is never touched; in the frontmatter only `notion_pulled:` (the page's Notion edit time that was pulled) and `updated:` change. Agents never pull (ADR-0045, vault `CONVENTIONS.md`).
_Avoid_: sync, import, mirror

**GitHub Issue Source**:
A **Ticket Source** of `kind: github`: the issues — never pull requests — of one repo (`owner/name`), read through one `gh` account on this Mac (the same accounts Automations use; Lotus stores no GitHub token). Always **Read only**; two statuses, Open and Closed (with its reason); rows show `#123`, a number and no key. Loads every open issue and the issues closed in the last 30 days (ADR-0048).
_Avoid_: GitHub board, GitHub project (GitHub Projects is a different product, not read in v1)

## Relationships

- A **Ticket Source** is one project in the tracker; a Lotus workspace is a project that is not a **Ticket Source**
- A Notion **Ticket Source** is either **Read only** or **Manage**; an Obsidian one is edited through the vault's own surgical edit path
- A **GitHub Issue Source** is always **Read only**; an agent delegated from a GitHub issue has `gh issue` write commands denied, but may push code and open pull requests
- **Source Health** belongs to a **Ticket Source**; "Write refused" belongs to one ticket, not to its source
- A Notion ticket has at most one **Matched Note**; a vault note with a **From Notion Section** is refreshed from the page it is matched with, or from its `notion:` link when that page is a row on a connected Notion source
- Notion and Obsidian code never import each other; they meet only in the ticket-source registry (**Matched Note**, **From Notion Section**)

## Frames

**Frame**:
A named set of things that share one context, such as one feature or one analysis. On a CodeCanvas canvas it is a visible area that holds nodes of any kind (terminal, agent, browser, note, shape); it replaces the old shape-only group. In a Code workspace it holds panes, and opening it shows only its panes. A **Frame** only organises: it does not make its agents work together (that idea was rejected as **Swarm**).
_Avoid_: Space, Section, Group, context group, region, area, team

**Split** (Code):
An unnamed Code **Frame**: panes side by side on one screen, made by splitting (⌘D, ⌘K, the add menu). The rail draws it as one line of its panes, with no name or colour; down to one pane, it dissolves.
_Avoid_: pane group, tab group

**Group** (Code):
A named Code **Frame**: a coloured card in the rail that holds panes and folds. Folded, it is one quiet row, its name in its colour. In GLOSSARY terms it is still a **Frame**; "group" is the word the UI uses.
_Avoid_: folder (that is the workspace), section

**Frame Overview**:
The camera zoomed out to show every **Frame** of the active canvas at once, opened from the grid button in the command bar. It is the same live canvas, not a gallery of thumbnails.
_Avoid_: Canvases (that is the project browser), all spaces, map

**Frame Suggestion**:
A one-click hint that offers to wrap loose nodes sharing a context (same worktree or branch, or spawned by the same agent) in a new **Frame**. It never moves nodes by itself.
_Avoid_: auto-group, smart frame

**Frame Switcher**:
The numbered chips (01, 02…) in the command bar, one per **Frame**, that fly the camera to that Frame and show its status.
_Avoid_: space dots, tabs

## Relationships

- A node joins a **Frame** by being dropped inside it and leaves by being dragged out; members move with their **Frame**
- A node outside every **Frame** is a loose node; canvases without Frames stay valid
- Every **Frame** is always visible at full strength; switching to one flies the camera to it, nothing fades
- Deleting a **Frame** keeps its members as loose nodes; old groups and agent diagram frames load as Frames
- A **Frame** is picked up only by its title tab or border; its empty inside behaves like the canvas
- The **Frame Overview** and the Canvases project browser are different places: the grid button opens the first, the project menu opens the second
- In a Code workspace, a pane belongs to at most one **Frame**; a pane outside every Frame is a loose pane and shows as its own row
- In a Code workspace, only splitting (⌘D, ⌘K, the add menu) puts a new pane beside the one on screen, in a **Split**; the rail's + opens a loose pane
- An existing pane moves into a **Group** by its menu ("Move to …", "New group with pane", "Take out") or by dragging its rail row or its header onto the group; dropping a header on another pane on screen swaps the two
- A Code **Frame** keeps its own layout, and both survive a restart; an empty Frame stays until it is deleted
- Opening a loose pane shows that pane alone; deleting a Code **Frame** never closes its panes, they become loose panes
- Canvas Frames and Code Frames are separate: making one in a mode does not make one in the other
- A pane an agent opens joins that agent's **Frame**; only when the agent has none does it join the Frame on screen

## Settings

**Lotus Settings**:
The one settings window of Lotus, a modal that opens from every mode. There is no second settings page.
_Avoid_: Canvas Settings (for the whole window), settings page, preferences

**Settings Group**:
A titled cluster of sections in the **Lotus Settings** sidebar: *Lotus* for settings that apply everywhere, then *Canvas*, *Code* and *Chat* for settings that only one mode uses.
_Avoid_: tab, mode tab

**Appearance**:
The app theme (System, Dark, Light) that colours the chrome and the Code and Chat modes.
_Avoid_: theme, style

**Canvas Style**:
The look of the canvas alone: its scenery, material and node palette.
_Avoid_: canvas theme, theme

## Relationships

- **Appearance** and **Canvas Style** are set separately; changing one never changes the other
- A setting that more than one mode uses belongs to the *Lotus* **Settings Group**, never to a mode's group
- "Canvas Settings" now names only the *Canvas* **Settings Group**, not the window

## Chat Swarm

> **Rejected 2026-11-11 (ADR-0066).** A manual trial showed the Board added nothing over `lotus_chat_delegate` + `tell`. These terms stay only so old plans read correctly; the feature built instead is **Delegate Verify**. Since 2026-11-12, `/swarm` exists again, but only as a built-in skill. It tells a Chat lead to split a task into verified, worktree-isolated delegates. There is no Board, no member-to-member messages and no new roles (`apps/desktop/scripts/lotus-swarm-skill.md`).

**Delegate Verify**:
The `verify` option on `lotus_chat_delegate`: when the child finishes, Lotus spawns a read-only verifier on the other provider, and bounces its `fail` reasons back to the child for up to 3 rounds. Merge stays a user click.
_Avoid_: swarm, review agent

**Swarm**:
One large task split across several agents in Chat that coordinate on one shared **Board**, started with `/swarm` from any Chat thread. Not the removed CodeSwarm module.
_Avoid_: team, crew, CodeSwarm

**Coordinator**:
The Chat thread that started a **Swarm**: it splits the work, briefs **Members**, judges their results and reports to the user. It does no technical work itself and never merges without the user's confirmation.
_Avoid_: lead (that is the one global Lead), director, foreman

**Member**:
A child Chat thread in a **Swarm** with one role: worker, verifier or monitor. Each Member has its own provider, model and effort, and starts with a clean context.
_Avoid_: sub-agent (an agent's own Agent-tool runs), child, worker (when the role is not meant)

**Board**:
The one shared, append-only channel of a **Swarm**, where every brief, diff, test result and question is posted with `@mentions`. Members never message each other privately.
_Avoid_: mailbox, ledger (both belong to Canvas collaboration), chat

## Relationships

- A **Swarm** has exactly one **Coordinator** and one **Board**, and one or more **Members**
- Any Chat thread can become a **Coordinator**; the Lead is one such thread, not the only one
- A **Member** acts only on posts that mention it; a sleeping **Member** costs nothing until mentioned
- Waking, pausing on quota, waking the monitor on silence and removing Members are rules in code; splitting, briefing and judging are the **Coordinator**'s

## Chat review

**Quote**:
A passage the user lifts out of an agent's reply in Chat. It waits as a card above the composer and goes with the next message.
_Avoid_: citation, excerpt

**Review note**:
A **Quote** of one or more lines in a thread's Changes diff, tied to a file and its line numbers, with the user's note on them. Removed lines are cited by their old line number.
_Avoid_: comment (GitHub and Notion comments), annotation (belongs to the browser), review comment

**Chat Attachment**:
An image, a file or pasted content that goes with one Chat message, on whichever machine the chat runs. On another machine it is a copy there, unless the file already lives on that machine.
_Avoid_: upload, asset (see **Note Asset**)

## Relationships

- A **Review note** is a kind of **Quote**: both wait above the composer and go with the next message, so a review is sent as one ordinary message
- A **Review note** shows as a marker on its lines in the diff while it waits; once sent, it lives only in the sent message

## Navigation

**Jump palette**:
One search, open from every mode, that takes the user to a workspace, a pane, a Chat thread or a mode. It only moves the user; it never runs a command. Opened empty, it lists what needs the user first, then what is working, then what was used last.
_Avoid_: command palette, quick switcher, command sheet

**Command sheet**:
The search of commands that belongs to one mode (Code, Chat or Canvas): launch an agent, add a pane, change the layout. Each mode has its own.
_Avoid_: palette, jump palette

**Needs you**:
The part of the **Jump palette** that lists what waits for the user, from every mode: Code panes (local and SSH), Chat threads, stopped Factory runs and **Automation Asks**. Two groups: **Waiting** (the agent asks for an answer or a permission, or failed) on top, then **Done, not seen** (a turn ended while the user was not looking). A Waiting item leaves when the agent works again; a Done item leaves when the user opens it.
_Avoid_: inbox (that is the Automation list), attention, feed

### Relationships

- A **Jump palette** is shared by all modes; a **Command sheet** belongs to one mode.
- **Needs you** is a part of the **Jump palette**, not a panel of its own; Canvas agents are not in it.
- Switching mode is a **Jump palette** row, not a shortcut of its own.
- A Chat thread shown in a pane appears once in the **Jump palette**, and jumping to it goes to that pane.

## Source control

**Git graph**:
The history of one repository, drawn as commits on branch lanes, in the Editor pane's sidebar beside Files, Source and Search. By default (Smart) it shows the current branch, its upstream, the main branch and the branches an agent's worktree has checked out; All shows every local branch. It also shows tags and the uncommitted changes on top, and marks commits not pushed or not pulled. It stays current on its own when any branch moves. It only shows; it never checks out, cherry-picks or reverts. Open wide shows the same graph as an editor tab with more columns. Opening a commit shows its message, its changed files and each file's diff against the first parent.
_Avoid_: git log, history view, commit tree

### Relationships

- A **Git graph** shows one repository at a time; a workspace with several repositories picks one.
- An inline blame line opens its commit in the **Git graph**'s commit view.
- A branch that an agent's worktree has checked out is marked in the **Git graph**.

## Flagged ambiguities

- "slash command" was used to mean both all `/...` entries and skill-only entries — resolved: use **Bridge Command** for all slash entries and **Bridge Skill** for skill-backed entries.
- "browser annotation" is overloaded — resolved: use **Canvas Browser Annotation** for CodeCanvas and **Browser Annotation Contract** for CodeSpace. Never abbreviate to "browser annotation" without the module prefix.
- "Agent Runner lives in the Swarm module" implied it was Swarm-owned — resolved: the **Agent Runner** and **Agent Runner Readiness Adapter** are the **Agent Runtime Kernel**, owned by no surface (ADR-0025).
- "live agent = promoted terminal" conflated two things — resolved: **Promote to Terminal** (one-way, claude-only prefill) is superseded by **Agent Execution Mode** `live`, which spawns a **Live Agent Session** via the **Agent Runtime Kernel** (provider-portable, readiness-aware) and keeps the agent's identity (ADR-0024).
- "agent finished / completed" was overloaded between *finished a turn* and *process exited* — resolved: **Turn-Done Signal** (idle watcher / OSC 133, agent still alive) drives **Agent-Done Callouts**; `AgentStatusRegistry` `completed` is **Session-Exit** (PTY ended) and must NOT be used as the callout trigger (ADR-0030).
- "automation" was used both for **Graph Run** (durable graph execution) and for trigger-started agent work — resolved: **Automation** means only the Trigger → Action → Output rule of ADR-0038; a **Graph Run** is never called an automation.
- "vault" was used for any ticket source — resolved: a vault is one kind of **Ticket Source** (`obsidian`); a Notion database is another. Say **Ticket Source** when either is meant.
- "Space" (mockup) and "group" (Cmd+G, shape-only) named two grouping ideas — resolved: one concept, **Frame**. "Space" is avoided because it sits next to **CodeSpace** and **Task Workspace**.
- "swarm" named both the removed CodeSwarm module (Swarm Task, Swarm Workflow, Director Panel, …) and Chat `/swarm` — resolved: **Swarm** means only the Chat concept; terms of the removed module were retired on 2026-11-11 (Task → **Task**, Swarm Intake Gate → **Task Intake**, Workflow Run → **Graph Run**, Swarm Agent → **Agent Definition**).
