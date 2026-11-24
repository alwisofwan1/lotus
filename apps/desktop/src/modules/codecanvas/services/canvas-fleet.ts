import { bridgePushCanvasFleetSnapshot, type McpFleetMemberPayload } from "@/lib/tauri-api";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import { deriveGating } from "@/lib/agent-runtime/agent-gating";
import type { AgentNodeStatus } from "../types/canvas";
import type { AgentStatusSnapshot } from "./agent-status-registry";
import { canvasRuntimePaneId } from "./canvas-runtime-scope";
import { runnerTurnCapability } from "./runner-capability";
import { agentHeadlineStore } from "./agent-headline-store";
import { resolveRunnerVisualIdentity } from "./runner-visual-identity";

const STATUS_TO_FLEET: Record<AgentNodeStatus, string> = {
  idle: "idle",
  connecting: "starting",
  running: "live",
  // Launch phase, NOT turn phase: a pane whose agent is waiting for a human is still a live
  // pane. `turn` is the field that carries "waiting for a human" (contract/README.md); leaking
  // it into `status` would collapse the very distinction this plan rests on.
  "needs-you": "live",
  completed: "exited",
  error: "exited",
  stalled: "stalled",
};

// A canvas agent is "alive" (addressable) whenever it has a usable live session — which INCLUDES
// `idle` (its normal ready-for-input state) and `stalled` (PTY still connected, just quiet: a health
// hint, NOT a terminal state). lotus_list_fleet is told to filter is_alive=true before reporting, so
// omitting these made an idle/quiet peer invisible and unreachable even though its session is alive;
// only truly terminal states (completed/error) are not addressable. A `stalled` peer must stay a
// valid dispatch target — a message may even un-stick it, and the Phase 2 delivery queue bounds any
// dispatch into a genuinely-dead one. (ADR-0030: an idle/settled teammate must remain addressable.)
const isActive = (status: AgentNodeStatus) =>
  status === "running" ||
  status === "connecting" ||
  status === "idle" ||
  status === "stalled" ||
  // A blocked agent is the most present thing on the board. Every predicate here is an
  // allowlist, so omitting it would have dropped an agent out of the fleet at the exact moment
  // it was asking a human for something — invisible on Pocket, unreachable by peers.
  status === "needs-you";

/**
 * Truthful fleet provider (Phase 4). A custom runner keeps its "custom" label instead of being
 * collapsed to "claude" — unless it's a custom-but-Claude-family runner (claudeFamily), which drives
 * the claude path and should report "claude". codex/cursor report themselves; claude-family
 * (claude/ccs/csp/undefined) reports "claude".
 */
function runnerToFleetProvider(runner: AgentRunnerType | undefined, claudeFamily?: boolean): string {
  if (runner === "codex" || runner === "cursor") return runner;
  if (runner === "custom") return claudeFamily ? "claude" : "custom";
  return "claude";
}

/** Whether a status is a live, ready-to-receive state (can accept a dispatch right now). */
// `needs-you` is included deliberately: a dispatch into a blocked agent may BE the answer that
// unblocks it, so refusing to route there would make the state unresolvable from another agent.
// This says "bytes will arrive", not "it will act on them" — `turn` is what tells a peer the
// difference between "will answer you" and "is answering you".
const canReceiveNow = (status: AgentNodeStatus) =>
  status === "running" || status === "idle" || status === "needs-you";

/**
 * Whether this runner can call the Lotus MCP tools.
 *
 * Keyed on the runner, not on "is it Claude": at startup Lotus installs the lotus MCP server for
 * every native runner it supports — `~/.claude.json` for the claude family, `~/.codex/config.toml`
 * for codex, and Cursor's own mcp.json (see `install_codex_mcp_config_entry` and
 * `cursor_mcp_config_path` in lib.rs). Reading the old `claudeFamily` fallback as the answer
 * published Codex agents as tool-less while they were demonstrably calling the tools.
 *
 * A custom runner is an arbitrary command, so unless it drives the claude path the answer is
 * genuinely unknown — as it is when the runner has not been reported yet. Both return `undefined`
 * so the key is omitted, which the fleet contract already reads as "this host cannot say"
 * (`mcp_tools_available: Option<bool>`), the same way `gating` is left absent below.
 */
function runnerHasLotusMcp(runner: AgentRunnerType | undefined, claudeFamily?: boolean): boolean | undefined {
  if (runner === undefined) return claudeFamily ? true : undefined;
  if (runner === "custom") return claudeFamily ? true : undefined;
  return true;
}

/**
 * Whether this runner produces the per-step hook events Chat's transcript is built from.
 *
 * Must agree with `provider_reports_steps` in `src-tauri/src/api_server/handlers/fleet.rs`
 * — the Rust side only consults that fallback when this field is *absent*, so a `false`
 * sent from here is final and turns into `transcriptOutlook: "never"` on the phone.
 *
 * **Codex joined on 2026-08-13** (`codex_hooks.rs`): Lotus registers `PreToolUse`,
 * `PostToolUse`, `Stop` and `UserPromptSubmit` in `~/.codex/hooks.json`, and the
 * agent-notify pipeline reads the payloads unmodified. This function kept answering
 * `false` for Codex after that landed, so a Codex cell whose transcript was being recorded
 * was told on the phone that none was ever coming (found 2026-08-27; the desktop's own
 * `session-history.jsonl` diagnostics showed `agent: codex, event: prompt-submit` bodies
 * arriving while Chat said "this runner does not report its steps").
 *
 * `ccs` / `csp` are `claude --profile …` and drive the same global hooks; they were also
 * being answered `false` here unless the snapshot happened to carry `claudeFamily`.
 *
 * `undefined` for an unreported runner, deliberately, and for the same reason
 * `runnerHasLotusMcp` returns it: the fleet contract reads an absent capability as "this
 * host cannot say", which is the truth here. Answering `true` is what made Chat wait
 * forever for steps that were never coming. A non-Claude custom runner is `false`: Lotus
 * installs no hook for it and cannot know what its command does.
 */
function runnerReportsSteps(runner: AgentRunnerType | undefined, claudeFamily?: boolean): boolean | undefined {
  if (runner === undefined && !claudeFamily) return undefined;
  return runnerTurnCapability(runner, claudeFamily).reportsSteps;
}

/** Where a canvas project lives and what a human calls it — all a remote client needs to place a cell. */
export interface CanvasProjectIdentity {
  cwd: string;
  /** Null when the host cannot name it; never a blank string (see `workspace_label` below). */
  name?: string | null;
}

export interface CanvasFleetContext {
  projectId: string | null;
  cwd: string;
  /**
   * Reads an agent's headline by pane id. Injected so this module stays a pure mapping and the
   * fleet shape can be tested without standing up the headline store; production passes the
   * process-wide store.
   */
  headlineFor?: (paneId: string) => string | undefined;
  /**
   * How a human names this project — the alias, else the root directory's last segment.
   *
   * Travels on every cell as `workspace_label`. Without it a remote client has only
   * `workspace_id` (`canvas:cp_2c73…`, unreadable) and `cwd`, and Lotus Pocket was
   * reduced to using the `cwd` basename of whichever cell happened to sort first — so
   * the project appeared to rename itself whenever the fleet reordered. The name is
   * known here and nowhere downstream, which is why it is stamped here (ADR-14,
   * `plans/lotus-pocket`).
   */
  projectName?: string | null;
  /**
   * Every project this window can name, keyed by project id — the answer for an agent
   * that belongs to a project **other than** the one on screen.
   *
   * A push carries whatever the agent registry holds, and that is not always one
   * project's worth: a project switch resolves its id before its board has hydrated, so
   * for one render the outgoing project's agents are pushed alongside the incoming
   * project's identity. Stamping the board's `cwd`/name on all of them is what put a
   * `terax-ai` agent into `codespace-demo` on Lotus Pocket — a row that dispatched
   * across projects, not merely a cosmetic ghost (measured live, 2026-08-10).
   *
   * Absent (or missing an id) is a real answer: the member then carries no `cwd` and no
   * label rather than another project's. Silence a client can fall back from beats a
   * confident lie it cannot detect.
   */
  projects?: Readonly<Record<string, CanvasProjectIdentity>>;
}

/**
 * The header label for a runner a node can name without help — `Claude Code`, `Codex`.
 *
 * A **custom** runner is deliberately absent: its label is its registry entry's name
 * (`acme`), which only the node knows once that entry has loaded, and it publishes it
 * on its snapshot. Guessing `CLI` here would put a placeholder on a phone that then
 * disagrees with the desktop — the exact mismatch this field exists to close.
 */
function builtInRunnerLabel(runner: AgentRunnerType | undefined): string | undefined {
  if (runner === undefined || runner === "custom") return undefined;
  return resolveRunnerVisualIdentity({ runner }).label;
}

/**
 * Which project an agent belongs to, where it lives, and what it is called.
 *
 * The project is the agent's **own**, and the board's only when the agent never said —
 * that single choice is the fix: stamping the board's project on every snapshot in the
 * push is what sent a `terax-ai` agent to Lotus Pocket labelled `codespace-demo`.
 *
 * The board on screen is still the freshest source for its **own** agents: its `cwd` and
 * name arrive with the project and are current by construction, where the catalog behind
 * them is refreshed less often. For an agent from another project the catalog answers,
 * and when it cannot, this says nothing rather than borrowing the board's values — an
 * unnamed project is a fallback a client handles, a misnamed one is a row that dispatches
 * into the wrong repo.
 */
function projectIdentityOf(
  snapshot: AgentStatusSnapshot,
  ctx: CanvasFleetContext,
): CanvasProjectIdentity & { workspaceId: string } {
  const projectId = snapshot.projectId ?? ctx.projectId ?? null;
  // The `canvas:` namespace marks a member as a board agent rather than a CodeSpace cell.
  const workspaceId = `canvas:${projectId ?? "default"}`;
  if (projectId === (ctx.projectId ?? null)) {
    return { workspaceId, cwd: ctx.cwd, name: ctx.projectName ?? null };
  }
  const known = projectId === null ? undefined : ctx.projects?.[projectId];
  // Empty cwd is the shape the fleet route already reads as "no cwd" (it omits the key),
  // so this needs no new sentinel.
  return { workspaceId, cwd: known?.cwd ?? "", name: known?.name ?? null };
}

export interface CanvasFleetAgentNodeRef {
  id: string;
  name: string;
  runner?: AgentRunnerType;
  runnerCommand?: string;
  projectId?: string | null;
}

/**
 * Projects canvas agent nodes into fleet members. The `canvas:<project>` workspace
 * namespace marks them apart from CodeSpace cells so lotus_list_fleet consumers can
 * tell them apart (and know they're not PTY-dispatchable).
 *
 * `address` is set to the agent's React node id so `fleet_target_matches` in Rust can
 * match dispatch targets by address (not just display_name), which is essential when
 * the calling agent sends `workspace_id` as the target (e.g. "canvas:projA") — the
 * sidecar normalizes it to "canvas-projA", and without `address` matching, the fleet
 * lookup falls back to display_name only, which can fail for agents whose name has
 * changed or was never a stable display_name in the fleet snapshot.
 */
/// **Agents only, never terminals.** The input is already filtered to `type === "agent"` by
/// `agentRefsFromNodes`, and that comment carries the reasoning — a Canvas Terminal node is
/// therefore absent from every remote surface, by construction rather than by accident
/// (`plans/session-history-hardening/issues/06`).
export function agentFleetMembers(snapshots: AgentStatusSnapshot[], ctx: CanvasFleetContext): McpFleetMemberPayload[] {
  const headlineFor = ctx.headlineFor ?? ((paneId: string) => agentHeadlineStore.get(paneId));
  return snapshots.map((s) => {
    const project = projectIdentityOf(s, ctx);
    const label = project.name?.trim();
    // Keyed on the pane id, not the node id: that is what the headline store, the turn registry and
    // the hook pipeline all agree on.
    const paneId = s.hookPaneId ?? s.id;
    const headline = headlineFor(paneId)?.trim();
    return {
      pane_id: paneId,
      workspace_id: project.workspaceId,
      cwd: project.cwd,
      // Omitted rather than sent empty: `workspace_label` absent means "this host
      // cannot name the project", which a client can fall back from. An empty
      // string would be a name, and a blank one.
      ...(label ? { workspace_label: label } : {}),
      provider: s.provider ?? runnerToFleetProvider(s.runner, s.claudeFamily),
      // What the desktop's own node header says (`Atlas · acme`), so a remote client
      // can print the same word. `provider` cannot carry it: a custom Claude-family
      // runner reports "claude" there by design, which is why Lotus Pocket showed
      // `claude` for two cells the desktop labelled `acme` and `HSS`.
      ...(s.runnerLabel?.trim() ? { runner_label: s.runnerLabel.trim() } : {}),
      display_name: s.name,
      address: s.id, // RC-3: enable fleet_target_matches to resolve by address
      status: STATUS_TO_FLEET[s.status],
      is_alive: isActive(s.status),
      // What a peer is WORKING ON, which no other field answers: `status` and `turn` give its state,
      // and `last_output_preview` is a raw terminal tail. Omitted rather than blank, the same rule
      // `workspace_label` follows — absent means "this host cannot say".
      ...(headline ? { headline } : {}),
      // A live persona's PTY session is what lets lotus_read_cell_output / dispatch_to_cell target it.
      session_id: s.sessionId ?? null,
      // Phase 4 capability truth — explicit snapshot flags win, else derive from status/claude-family.
      can_reply: s.canReply ?? canReceiveNow(s.status),
      can_queue: s.canQueue ?? isActive(s.status),
      mcp_tools_available: s.mcpToolsAvailable ?? runnerHasLotusMcp(s.runner, s.claudeFamily),
      // Derived here because this is the only place the runner is known for what it is;
      // `provider` below has already collapsed the Claude family into one label.
      reports_steps: runnerReportsSteps(s.runner, s.claudeFamily),
      // Derived here because this is where the launch command is known; the value
      // travels, the command does not (ADR-8).
      gating: s.runner === undefined ? undefined : deriveGating(s.runner, s.runnerCommand),
    };
  });
}

export function projectCanvasAgentStatusSnapshots(
  agents: readonly CanvasFleetAgentNodeRef[],
  snapshots: readonly AgentStatusSnapshot[],
  ctx: CanvasFleetContext,
): AgentStatusSnapshot[] {
  const snapshotById = new Map(snapshots.map((s) => [s.id, s]));
  const visibleIds = new Set(agents.map((agent) => agent.id));
  const projected = agents.map((agent): AgentStatusSnapshot => {
    const snapshot = snapshotById.get(agent.id);
    return {
      id: agent.id,
      name: snapshot?.name ?? agent.name,
      status: snapshot?.status ?? "connecting",
      hookPaneId: snapshot?.hookPaneId ?? canvasRuntimePaneId(agent.projectId ?? ctx.projectId, agent.id),
      sessionId: snapshot?.sessionId ?? null,
      hookCapable: snapshot?.hookCapable,
      projectId: snapshot?.projectId ?? agent.projectId ?? ctx.projectId ?? undefined,
      aliases: snapshot?.aliases,
      runner: snapshot?.runner ?? agent.runner,
      runnerCommand: snapshot?.runnerCommand ?? agent.runnerCommand,
      claudeFamily: snapshot?.claudeFamily,
      provider: snapshot?.provider,
      runnerLabel: snapshot?.runnerLabel ?? builtInRunnerLabel(snapshot?.runner ?? agent.runner),
      canReply: snapshot?.canReply,
      canQueue: snapshot?.canQueue,
      mcpToolsAvailable: snapshot?.mcpToolsAvailable,
    };
  });
  return [...projected, ...snapshots.filter((snapshot) => !visibleIds.has(snapshot.id))];
}

export function projectCanvasAgentFleetMembers(
  agents: readonly CanvasFleetAgentNodeRef[],
  snapshots: readonly AgentStatusSnapshot[],
  ctx: CanvasFleetContext,
): McpFleetMemberPayload[] {
  return agentFleetMembers(projectCanvasAgentStatusSnapshots(agents, snapshots, ctx), ctx);
}

export function pushCanvasFleet(snapshots: AgentStatusSnapshot[], ctx: CanvasFleetContext): Promise<void> {
  return bridgePushCanvasFleetSnapshot(agentFleetMembers(snapshots, ctx));
}
