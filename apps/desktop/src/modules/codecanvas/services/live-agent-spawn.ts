import { applyRunnerSessionTemplate, isClaudeFamilyRunner, isUngatedMode, resolveRunnerCommand, type AgentRunnerType, type RunnerSessionMode } from "@/lib/agent-runtime";
import { runnerTuningArgv } from "@/lib/agent-runtime/agent-tuning";
import { buildAgentIdentityPreamble, type AgentIdentityInput } from "@/lib/agent-catalog/identity-preamble";
import { buildSpawnArgv } from "@/lib/agent-runtime/spawn-argv";
import { buildAgentRunPrompt, type AgentContextSource } from "./agent-run-prompt";
import { shellQuote } from "./task-terminal-command";

export interface LiveAgentSpawnInput {
  /** CLI runner cached from the definition; omitted = claude. */
  runner?: AgentRunnerType;
  /** Required when runner = "custom". */
  runnerCommand?: string;
  /**
   * Set on a `custom` runner that is actually Claude Code (a different account/profile wrapper, e.g.
   * `ccs <profile>`). When true, the custom runner gets full claude-family treatment —
   * `--append-system-prompt` (identity + peer capability), `--model`, session pinning — so a
   * second-account Claude can collaborate like any built-in claude runner. See {@link isClaudeFamilyRunner}.
   */
  claudeFamily?: boolean;
  /** Model alias; `--model` on claude-family runners, `-m` on codex (`agent-tuning.ts`). Omitted = CLI default. */
  model?: string;
  /** How hard it thinks, on the runner's own scale; `--effort` / `-c model_reasoning_effort`. Omitted = CLI default. */
  effort?: string;
  /** "safe" = read-only; anything else = full access. */
  permissionMode?: string;
  /** Per-runner extra flags from the Runner Registry (ADR-0027), appended to the command. */
  extraFlags?: string;
  /** Session id to pin (ADR-0027 Phase 5). With sessionMode "new" → `--session-id`; "resume" → `--resume`. */
  sessionId?: string;
  /**
   * Where the persona lives on disk. When set, the TYPED command reads it back with `"$(cat …)"`
   * instead of carrying it inline.
   *
   * Measured 2026-09-12 against the running app: the resume path types its whole command into a
   * shell, and at ~2.5 KB the tty's input queue fills. The line discipline then rings the bell for
   * every further character and discards it — the pane ends in a run of BELs, the closing quote
   * never arrives, and no CLI ever starts. Naming a file keeps the typed line ~200 bytes. The argv
   * path is unaffected and still carries the prompt raw, because it needs no shell at all
   * (`plans/codecanvas-session-refactor/issues/08`).
   */
  systemPromptFile?: string | null;
  /**
   * A custom runner's own `{id}` templates, from its Runner Registry entry (Session Widget,
   * Slice 06). Absent for built-in runners, which are described by the kernel's own table.
   */
  resumeTemplate?: string | null;
  newSessionTemplate?: string | null;
  /** Whether sessionId starts a fresh session (pre-mint) or resumes a stored one. Default "resume". */
  sessionMode?: RunnerSessionMode;
  /** Optional persona-overlay role prompt. Empty/omitted = CNVS-pure bare launch. */
  rolePrompt?: string;
  /**
   * The agent's canvas display handle (e.g. "Rowan"). When set (claude-family), a lightweight
   * identity overlay is injected so the agent knows its own name, owns it, and answers in a
   * consistent house voice — WITHOUT forcing a specialist role (ADR-0027 stays role-free). Omitted =
   * a truly bare CNVS launch. See {@link buildCanvasIdentityPreamble}.
   */
  agentName?: string;
  appliedSkills?: string[];
  context?: AgentContextSource[];
  /**
   * Other teammate handles currently on the canvas. Fed into the identity overlay as a best-effort
   * spawn-time snapshot; the live roster is always discoverable via `lotus_list_fleet`. Also passed to
   * the persona overlay's roster block when a plan-emitting role is set.
   */
  roster?: string[];
  /** A concrete task to auto-submit after readiness; absent = the persona spawns ready and idle. */
  task?: string;
  /**
   * Inject the out-of-band peer-messaging capability into the system prompt (ADR-0030). Canvas live
   * spawns pass `true` so an agent can reach teammates; default off keeps a bare launch CNVS-pure
   * (claude-family only — codex/custom have no system-prompt flag).
   */
  includePeerCapability?: boolean;
  /**
   * Inject the canvas-control capability into the system prompt: the agent learns it may pan/focus or
   * tidy the user's canvas via lotus_focus_cell / lotus_arrange_canvas. Pass `true` ONLY when the user
   * has enabled "Let agents move the canvas & focus" (Settings → Canvas) — otherwise the bridge denies
   * the call, so advertising the tools would just waste turns. Claude-family only (system-prompt flag).
   */
  includeCanvasControlCapability?: boolean;
  /** Durable CodeCanvas project memory block, pre-ranked and formatted by the memory read model. */
  projectMemoryPrompt?: string;
  /**
   * Lean rules-and-decisions variant for runners with no `--append-system-prompt`. It is typed into
   * the pane as first-turn text, so it must stay short — see `buildProjectMemoryBriefBlock`.
   */
  projectMemoryBrief?: string;
}

export interface LiveAgentSpawnSpec {
  /** The interactive runner CLI to spawn, with the persona injected as a system prompt. */
  command: string;
  /** The task to auto-submit once ready, or null for a bare persona spawn (nothing is submitted). */
  submitText: string | null;
  /**
   * Phase 5 — a runner-agnostic peer bootstrap for runners without `--append-system-prompt`
   * (codex/cursor/non-Claude custom): identity + peer/canvas-control awareness delivered as a
   * first-turn submit BEFORE {@link submitText}, once per fresh session. `null` for claude-family
   * runners (their awareness rides in the system prompt) and bare CNVS launches.
   */
  bootstrapText?: string | null;
  /**
   * argv for the direct (shell-less) spawn path — the CLI as the PTY child, skipping the login
   * shell + typed-command hop. `null`/absent when only the shell path is safe: the base command
   * carries shell syntax (quotes/escapes/operators) we can't tokenize with confidence.
   */
  argv?: string[] | null;
  /**
   * The system prompt this spec injects, raw. Exposed so the caller can write it to the file it
   * named in {@link LiveAgentSpawnInput.systemPromptFile} before the command runs.
   */
  systemPrompt?: string | null;
}

/** The launch flags a runner contributes to a live agent, resolved from the Runner Registry. */
export interface ResolvedRunnerLaunch {
  permissionMode: string;
  extraFlags?: string;
}

/**
 * Merge a live-agent node's launch config with its runner's saved Runner Registry config
 * (ADR-0027 Phase 3 → spawn wiring). The registry holds per-runner launch defaults; this is the
 * single place that decides the effective permission mode + extra flags handed to the spawn spec.
 *
 * Precedence for permission mode:
 *   1. A node asking for **any gated stop** stays gated — node-level safety always wins.
 *   2. Else the registry decides: skip-permissions off → "safe"; on → "full" (YOLO).
 *   3. No registry entry for this runner (e.g. ccs/csp/custom) → keep the node's own mode (default "full").
 *
 * **Rule 1 read `mode === "safe"` until 2026-08-27, and that was the whole bug.** The intent
 * was always "a request to be gated has somewhere to land"; the test for it was a single word.
 * When the phone's scale grew, `manual` — a request to be gated if there ever was one — failed
 * that test, fell to rule 2, and met a registry whose `skip_permissions` defaults to **true**
 * for an unconfigured runner. The operator chose *manual* on the phone and watched a cell
 * spawn with `--dangerously-skip-permissions`. It asks {@link isUngatedMode} now, which is the
 * question rule 1 was always trying to ask.
 *
 * The registry's skip-permissions defaults to true (YOLO) for unconfigured runners, so a fresh
 * install launches exactly as before — this wiring only *adds* the ability to turn YOLO off or
 * append extra flags per runner.
 */
export function resolveRunnerLaunch(opts: {
  nodePermissionMode?: string;
  registrySkipPermissions?: boolean;
  registryExtraFlags?: string;
}): ResolvedRunnerLaunch {
  const { nodePermissionMode, registrySkipPermissions, registryExtraFlags } = opts;
  const asksToBeGated =
    nodePermissionMode !== undefined &&
    nodePermissionMode.trim() !== "" &&
    !isUngatedMode(nodePermissionMode);
  const permissionMode =
    asksToBeGated
      ? nodePermissionMode
      : registrySkipPermissions === false
        ? "safe"
        : registrySkipPermissions === true
          ? "full"
          : nodePermissionMode ?? "full";
  const extraFlags = registryExtraFlags?.trim() || undefined;
  return { permissionMode, extraFlags };
}


/**
 * Out-of-band peer-messaging capability (ADR-0030). Injected ONCE into a claude-family live agent's
 * system prompt so it knows it can reach teammates — WITHOUT polluting per-turn task messages (the
 * documented system-prompt home for tool-usage policy). Static: no roster is baked in (peers change);
 * the agent discovers who's available at call time via `lotus_list_fleet`. A bare runner-first launch
 * carries only this line — infrastructure awareness, not a persona (a minimal amendment to ADR-0027).
 * The closing clause keeps a solo/normal task clean by gating the behavior on actual intent.
 */
export const CANVAS_PEER_MESSAGING_CAPABILITY =
  "You are one agent on a shared Lotus canvas alongside other agents. When a task asks you to contact, " +
  "hand off to, or message another agent, first call lotus_list_fleet to see who is available. " +
  // Contract clarity (Phase 3): target by pane_id, NOT display_name — the prompt must agree with the
  // dispatch tool's schema, which rejects workspace_id/display_name as the target.
  "Each member has a pane_id (the exact target), a display_name (a human-readable label), and optional " +
  "aliases (for recognition only). Dispatch by the target's pane_id via " +
  "lotus_dispatch_to_cell({ paneId, command, replyTo }); never pass a workspace_id (e.g. 'canvas:projA') " +
  "or a display_name/alias as the paneId. Do this only when the task actually calls for reaching another " +
  "agent — otherwise just do the work yourself. " +
  // Fleet-inconsistency guidance: a startup race can hide a teammate for a beat. Re-list before
  // concluding they're gone, and never claim a teammate the user can see "does not exist".
  "If a teammate you were told is on the canvas doesn't appear in the fleet, call lotus_list_fleet again " +
  "before concluding they're gone; if they still don't show, report that the fleet looks inconsistent " +
  "rather than claiming they don't exist. " +
  // Reply-back protocol (push, not poll): completion travels as a dispatch, so nobody burns turns
  // polling read_cell_output / wait_cell_idle to discover a teammate finished.
  "When you delegate work and need the outcome, pass replyTo with your own name so the teammate " +
  "reports back to you when done — do not poll their output waiting for it. Conversely, when a " +
  "dispatched task names a sender to report back to, dispatch your result back to them the moment " +
  "you finish instead of only printing it.";

/**
 * Notes awareness (ADR-0047). A note wired to an agent is its context, but a live agent only sees
 * a note's text when it ASKS for it — the canvas never pushes note text into a typed conversation.
 * Injected with the peer line (every canvas agent); the tool itself works from any mode.
 */
export const CANVAS_NOTES_CAPABILITY =
  "Notes wired to you on this canvas are your context. When the user mentions a note, or a task " +
  "depends on one, call lotus_notes_read first — no arguments needed — before anything else; pass " +
  "scope 'project' to read every note on the board. If the tool is not in your tool list yet, load it " +
  "with ToolSearch (query \"lotus_notes_read\"). Never read notes by calling the Lotus app over HTTP or " +
  "by searching files: notes are not files, and the tool is the one supported way. " +
  "When the user asks you to add to, update or create a note, write it yourself with lotus_notes_write " +
  "(append by default; pass the editedAt you read as expectedEditedAt) instead of asking them to paste it.";

/**
 * Out-of-band canvas-control capability. Injected (claude-family) ONLY when the user enabled
 * "Let agents move the canvas & focus" (Settings → Canvas), so the agent can guide the user's view at
 * meaningful moments. Like the peer line, the closing clause gates the behavior on real intent so a
 * normal task doesn't trigger gratuitous camera moves.
 */
export const CANVAS_CONTROL_CAPABILITY =
  "You can guide the user's view on this canvas. Call lotus_focus_cell with a node's name (a teammate, " +
  "a terminal, a task) to pan and zoom the user's camera to it, or lotus_arrange_canvas to tidy every " +
  "node into a grid. Use these sparingly and only when it genuinely helps the user follow along — e.g. " +
  "when you begin a substantial step the user should watch, when you hand off to a teammate, or when " +
  "the canvas has grown cluttered. Never move the camera on routine steps.";

/**
 * Resolve a custom runner's Runner Registry entry by its launch command. A custom-runner agent node
 * stores the GENERIC `runner: "custom"` type plus its `runnerCommand`, while the registry keys the
 * entry by a SPECIFIC id (e.g. "custom-acme"). So `getRunner("custom")` always misses and the
 * entry's flags (skip-permissions, extra_flags, and crucially `claude_family`) never reach the spawn.
 * Matching by the exact command recovers it. Generic over the minimal shape so it stays a pure,
 * dependency-light leaf (testable without the tauri-api types).
 */
export function matchCustomRunnerByCommand<T extends { custom?: boolean; command?: string }>(
  runnerCommand: string | undefined,
  runners: readonly T[],
): T | null {
  const cmd = runnerCommand?.trim();
  if (!cmd) return null;
  return runners.find((r) => r.custom === true && (r.command ?? "").trim() === cmd) ?? null;
}

export interface CanvasBootstrapBriefInput {
  /** The agent's canvas handle (e.g. "Nova"). Blank/omitted → no identity line. */
  name?: string;
  /** Other teammate handles currently on the canvas (best-effort spawn-time snapshot). */
  roster?: readonly string[];
  /** Advertise the peer-messaging tools (lotus_list_fleet / lotus_dispatch_to_cell). */
  includePeerCapability?: boolean;
  /** Advertise the canvas-control tools (lotus_focus_cell / lotus_arrange_canvas). */
  includeCanvasControlCapability?: boolean;
}

/**
 * Lean first-turn brief for runners WITHOUT a system-prompt flag (codex/cursor/non-Claude custom).
 * Unlike the claude-family path — where the full {@link CANVAS_PEER_MESSAGING_CAPABILITY} /
 * {@link CANVAS_CONTROL_CAPABILITY} prose rides INVISIBLY in `--append-system-prompt` — a non-claude
 * runner's bootstrap is TYPED into the terminal as a visible first message. Re-typing the verbose
 * argument-level protocol there just floods the pane with a wall of text (the exact regression the
 * user hit with Qwen).
 *
 * These runners have the Lotus MCP wired (e.g. codex `config.toml` `[mcp_servers.lotus]`), so the
 * pane_id/workspace_id/replyTo rules already live in the MCP tool DESCRIPTIONS, which the model reads
 * at call time. The brief therefore only makes the agent AWARE — who it is, that it shares the canvas,
 * and which tools exist — and defers the "how" to the schemas. Pure and deterministic (no Date.now /
 * Math.random / React); returns "" when nothing is requested so callers can compose it unconditionally.
 */
export function buildCanvasBootstrapBrief(input: CanvasBootstrapBriefInput): string {
  const name = input.name?.trim() ?? "";
  const lines: string[] = [];

  if (name) {
    const others = (input.roster ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry.toLowerCase() !== name.toLowerCase());
    const teamLine = others.length ? ` Teammates here right now: ${others.join(", ")}.` : "";
    lines.push(
      `You are ${name}, a teammate on a shared Lotus canvas — a live agent development environment a human is watching in real time. Own the name, keep replies conversational, and work like a sharp senior generalist.${teamLine}`,
    );
  }

  if (input.includePeerCapability) {
    lines.push(
      "You share this canvas with other agents. When a task asks you to reach one, use your Lotus tools: " +
        "lotus_list_fleet to see who's here, then lotus_dispatch_to_cell to hand off work — pass replyTo with " +
        "your own name so they report back instead of you polling. Each tool's own description spells out the " +
        "exact arguments; only reach for them when the task actually calls for another agent.",
    );
    lines.push(
      "Notes wired to you are your context — call lotus_notes_read first; never curl the Lotus app or search files for them. " +
        "To add to or create a note, use lotus_notes_write yourself.",
    );
  }

  if (input.includeCanvasControlCapability) {
    lines.push(
      "You may guide the user's view — lotus_focus_cell to pan/zoom to a node, lotus_arrange_canvas to tidy up — " +
        "but only when it genuinely helps them follow along, never on routine steps.",
    );
  }

  return lines.join("\n\n");
}

export type CanvasIdentityInput = Omit<AgentIdentityInput, "surface">;

/**
 * The canvas spelling of the shared identity overlay.
 *
 * The prose moved to `lib/agent-catalog/identity-preamble.ts` when the unified shell needed the
 * same four layers for a pane in a folder (only the place changes: "this canvas" against "this
 * workspace"). This wrapper stays because the canvas is the surface that named the idea and every
 * caller here already says `Canvas`.
 */
export function buildCanvasIdentityPreamble(input: CanvasIdentityInput): string {
  return buildAgentIdentityPreamble({ ...input, surface: "canvas" });
}

/**
 * Resolves how to bring a live Canvas Agent Node persona online (ADR-0022/0023).
 *
 * CNVS-pure by default (ADR-0027): a launched runner is just the CLI — no baked role, no model.
 * Role emerges from terminal input; model from the CLI default / `/model`. A `role`/`model` is
 * injected **only when explicitly set** (the optional persona overlay), via `--append-system-prompt`
 * + `--model` on claude-family runners — so the agent then spawns *ready* and idle with that identity.
 * Opt-in (ADR-0030): when `includePeerCapability` is set (the canvas does), claude-family runners get a
 * tiny peer-messaging capability line in the system prompt — out-of-band tool-awareness, not a persona —
 * so even a bare launch can reach teammates. A concrete `task`, when present, is the only thing
 * auto-submitted (after readiness).
 *
 * Codex/cursor/custom runners have no system-prompt flag, so any overlay role is deferred (Fase 3);
 * they always spawn the bare interactive CLI via the kernel.
 */
export function buildLiveAgentSpawnSpec(input: LiveAgentSpawnInput): LiveAgentSpawnSpec {
  const runner = input.runner ?? "claude";
  const isClaudeFamily = isClaudeFamilyRunner(runner, input.claudeFamily);
  const role = input.rolePrompt?.trim();
  const model = input.model?.trim();

  // A custom runner's session method travels with its Runner Registry entry, because `custom` covers
  // grok, opencode and a second-account Claude alike — the built-in table cannot tell them apart
  // (Session Widget, Slice 06). Built-ins ignore this: their template is always absent.
  // A claude-family custom runner (`ccs <profile>`, `csp …`) IS Claude behind a wrapper, so it takes
  // Claude's own resume flag even when nobody typed a template for it. Without this default, HSS-style
  // runners captured a session id and then launched bare — the id was stored and never used.
  //
  // Only for `resume`: Claude ignores `--session-id`, so there is no pre-mint fallback to give.
  //
  // Scoped to `custom` on purpose: a BUILT-IN claude/ccs/csp already gets its flag from the kernel's
  // own session table, and adding the fallback there appended `--resume <id>` twice.
  const resumeTemplate =
    input.resumeTemplate ?? (runner === "custom" && isClaudeFamily ? "--resume {id}" : undefined);
  const customSessionPart = applyRunnerSessionTemplate(
    input.sessionMode === "new" ? input.newSessionTemplate : resumeTemplate,
    input.sessionId,
  );
  const baseCommand = [
    resolveRunnerCommand(runner, input.runnerCommand, input.permissionMode, input.extraFlags, input.sessionId, input.sessionMode),
    customSessionPart,
  ]
    .filter(Boolean)
    .join(" ");
  const parts = [baseCommand];
  let promptArgv: string[] = [];
  let injectedSystemPrompt: string | null = null;
  // Pin the model / effort whenever one is set (NL "spawn a claude opus agent", or the phone's summon
  // sheet), even for a bare runner-first launch with no role overlay — otherwise the CLI uses its own
  // default. Per-family flags live in `agent-tuning.ts`; a custom runner that is not claude-family gets
  // nothing, because its command owns its flags.
  const modelArgv = runner === "custom" && !isClaudeFamily
    ? []
    : runnerTuningArgv(runner, { model, effort: input.effort }, isClaudeFamily);
  // The codex effort token carries TOML quotes, so it is shell-quoted in the typed command; argv
  // below takes it verbatim (portable_pty passes tokens through, no shell involved).
  if (modelArgv.length > 0) parts.push(modelArgv.map((t) => (/[\s"']/.test(t) ? shellQuote(t) : t)).join(" "));
  // System prompt for claude-family runners. Two independent, additive parts (ADR-0027 + ADR-0030):
  //   • persona overlay (live contract + role/skills/context) — ONLY when a role is set;
  //   • peer-messaging capability (out-of-band tool-awareness, not a persona) — ONLY when the caller
  //     opts in via includePeerCapability (the canvas does).
  // With neither, a bare runner-first launch stays CNVS-pure (no --append-system-prompt at all).
  if (isClaudeFamily) {
    // "safe" → keep permissions (read-only); the injected contract mirrors it so the two never disagree.
    const skipPermissions = input.permissionMode !== "safe";
    const rolePart = role
      ? buildAgentRunPrompt({
          operatingMode: "live",
          rolePrompt: role,
          skills: input.appliedSkills,
          context: input.context,
          roster: input.roster,
          skipPermissions,
        })
      : "";
    // Identity + voice overlay (revises ADR-0027): threads the canvas handle into the prompt so the
    // agent owns its name and speaks in a consistent house voice. Role-free — no specialist role forced.
    const identityPart = input.agentName
      ? buildCanvasIdentityPreamble({ name: input.agentName, roster: input.roster })
      : "";
    const capabilityPart = input.includePeerCapability ? `${CANVAS_PEER_MESSAGING_CAPABILITY}\n\n${CANVAS_NOTES_CAPABILITY}` : "";
    const canvasControlPart = input.includeCanvasControlCapability ? CANVAS_CONTROL_CAPABILITY : "";
    const projectMemoryPart = input.projectMemoryPrompt?.trim() ?? "";
    // Order: explicit role → identity → mechanical capabilities (peer, canvas-control). Identity leads
    // for a bare canvas launch so the agent knows itself before it learns its tools.
    const systemPrompt = [rolePart, identityPart, projectMemoryPart, capabilityPart, canvasControlPart].filter(Boolean).join("\n\n");
    if (systemPrompt) {
      const file = input.systemPromptFile?.trim();
      parts.push(
        file
          ? `--append-system-prompt "$(cat ${shellQuote(file)})"`
          : `--append-system-prompt ${shellQuote(systemPrompt)}`,
      );
      promptArgv = ["--append-system-prompt", systemPrompt];
      injectedSystemPrompt = systemPrompt;
    }
  }

  // Phase 5 — runner-agnostic peer bootstrap. Codex/cursor/non-Claude-custom runners have no
  // --append-system-prompt, so their identity + peer/canvas-control awareness can't ride in the
  // command. Instead we compose it as plain text delivered as a FIRST-TURN submit (separated from
  // the user task), once per fresh session (the launch controller sends it on ready, never on
  // reattach). Claude-family runners keep the system-prompt path → no bootstrap.
  //
  // Unlike the claude-family system prompt (invisible), this text is TYPED into the terminal, so it
  // uses the LEAN brief — these runners have the Lotus MCP wired, so the verbose pane_id/replyTo
  // protocol already lives in the MCP tool descriptions. The brief just makes the agent aware; it
  // does not re-type the wall of prose that flooded the pane before. See {@link buildCanvasBootstrapBrief}.
  let bootstrapText: string | null = null;
  if (!isClaudeFamily) {
    // Project memory rides here too, in its lean form: these runners never see the system prompt, so
    // without this they work inside a project while blind to its rules. The full block stays out —
    // this text is typed into the pane.
    bootstrapText =
      [
        buildCanvasBootstrapBrief({
          name: input.agentName,
          roster: input.roster,
          includePeerCapability: input.includePeerCapability,
          includeCanvasControlCapability: input.includeCanvasControlCapability,
        }),
        input.projectMemoryBrief?.trim() ?? "",
      ]
        .filter(Boolean)
        .join("\n\n") || null;
  }

  const task = input.task?.trim();
  return {
    command: parts.join(" "),
    submitText: task ? task : null,
    bootstrapText,
    argv: buildSpawnArgv(baseCommand, modelArgv, promptArgv),
    systemPrompt: injectedSystemPrompt,
  };
}

