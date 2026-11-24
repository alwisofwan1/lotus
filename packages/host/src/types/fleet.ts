// ─── Fleet (Bridge MCP) ───────────────────────────────────────────────────────

import type { BridgeProvider } from "./api.js";
import type { ProviderUsage } from "./provider-bridge.js";
import type { HostedProject } from "./projects.js";

/**
 * Mirrors `FleetMember` in
 * `apps/desktop/src-tauri/src/api_server/handlers/fleet.rs`. Keep the two in step.
 *
 * Every field below `isAlive` is optional because the desktop may be older than
 * this package — the host must degrade gracefully rather than assume the newest
 * payload shape.
 */
export interface FleetMember {
  paneId: string;
  workspaceId: string;
  /** Provider currently driving the cell — the Rust side's `provider`. */
  agentType: BridgeProvider;
  /**
   * The runner's name as the desktop prints it (`acme`, `Codex`) — the Rust side's
   * `runner_label`. Absent when that host cannot name it.
   *
   * Not a duplicate of {@link FleetMember.agentType}: that one is the family a client
   * routes on and reports `claude` for every custom Claude-family runner, which is why
   * a phone reading it alone disagreed with the desktop beside it.
   */
  runnerLabel?: string;
  /** Persona name, not the pane id — the Rust side's `display_name`. */
  title: string;
  /**
   * Launch-phase status (`live`, `idle`, …): whether the pane exists and runs.
   * NOT whether the agent is mid-turn — read {@link FleetMember.turn} for that.
   */
  status: string;
  isAlive: boolean;
  /** `false` for a cell run with no terminal (a Chat cell), so a client hides its Terminal view. Absent: it has one. */
  terminal?: boolean;

  /** Working directory; distinguishes two workspaces with the same name. */
  cwd?: string;
  /** Human-readable workspace label, when the desktop supplied one. */
  workspaceLabel?: string;
  /** Last line of PTY output — lets a cell card show motion without a stream. */
  lastOutputPreview?: string;
  /** The operator's ask, first line, as the canvas card shows it: what the agent is *for*. */
  headline?: string;
  /** Agent CLI session id, once the pane has been correlated to one. */
  sessionId?: string;

  /**
   * Turn-accurate state from the agent's stop hook: `idle`, `needs-input`,
   * `running`, `error`, `ended`. Absent when no hook has fired for this pane
   * (non-Claude-family runner, hook not installed, or never correlated).
   *
   * `needs-input` is the one state that means a human is actually needed. It
   * also arrives as an event on `/api/notifications/stream`, but only to
   * clients connected at that moment; this field is what lets a client that
   * starts cold discover it from a plain snapshot.
   */
  turn?: string;
  /** Age of {@link FleetMember.turn} in ms — a stale signal reads differently. */
  turnAgeMs?: number;

  /**
   * Which authenticated account this cell works as, when one was chosen.
   *
   * Absent means the runner's own default. Worth showing beside the cell: with several
   * accounts on a machine, "which one is this" is not answerable from anything else, and a
   * running cell cannot be moved to another.
   */
  profileId?: string;

  /**
   * The plan window the runner behind this cell last reported.
   *
   * Per cell rather than per account, because a running cell's own stream is the only place
   * this is learned. Absent means **this runner does not say** — never that the plan is fine.
   */
  usage?: ProviderUsage;

  /**
   * Whether this cell asks before acting (ADR-8).
   *
   * - `asks` — Claude-family cell launched with permissions on; it prompts per
   *   action, and that prompt reaches the operator as `turn: "needs-input"`.
   * - `skipped` — Claude-family cell launched with the gate off. Fixable by
   *   respawning it in safe mode.
   * - `runner_cannot` — the runner has no hook mechanism at all (`codex`,
   *   `cursor`), so it can never prompt. Not fixable.
   *
   * Absent means **unknown**, never ungated: a custom runner's command is
   * arbitrary, and understating risk is the one error worth avoiding here.
   */
  gating?: "asks" | "skipped" | "runner_cannot";

  /**
   * The model this session last answered with, as the agent CLI wrote it in its own
   * transcript (`claude-opus-5-5`, `gpt-5.6-luna`). Never a runner default: absent when no
   * transcript is known for the pane yet, or the runner does not record one.
   */
  model?: string;
  /** The git branch the session reports. Absent outside a repo, same rule as `model`. */
  branch?: string;
}

export interface ListFleetQuery {
  workspaceId?: string;
  page?: number;
  pageSize?: number;
}

export interface ListFleetResponse {
  items: FleetMember[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReadCellRequest {
  paneId: string;
  /** Max tail bytes to return (server clamps to 64K). */
  tailBytes?: number;
}

export interface ReadCellResponse {
  paneId: string;
  tail: string;
  bytes: number;
}

export interface ScrollbackRequest {
  paneId: string;
  /** Absolute offset to read from — the ring buffer is byte-addressed. */
  fromByte: number;
  maxBytes?: number;
}

export interface ScrollbackResponse {
  paneId: string;
  text: string;
  /**
   * Where {@link ScrollbackResponse.text} starts. Greater than the requested
   * `fromByte` when the ring buffer moved on — the gap a client reports as
   * `cell.truncated` instead of pretending the output was continuous.
   */
  offset: number;
  totalBytes: number;
}

/**
 * The two postures every caller before the phone's permission scale knew about.
 *
 * **Kept as a named pair rather than folded into {@link SpawnCellRequest.permissionMode},
 * because they are still the whole vocabulary of two other callers** — the MCP spawn tool
 * and the desktop's own bridge — and of every phone built before 2026-08-27. They are now
 * the *legacy* half of an open set: a spawn may also carry a mode id from the runner's own
 * scale (`manual`, `acceptEdits`, `read-only`, …), which is what `bootstrap.runners[]`
 * advertises through {@link TunedRunner.permissions}.
 */
export type PermissionMode = "safe" | "yolo";

export interface SpawnCellRequest {
  /** Which agent to launch: `claude`, `codex`, … */
  provider: string;
  /** Workspace target; the desktop window uses its active one when absent. */
  workspaceId?: string;
  /** First task, typed into the cell once it is up — spawn and brief in one call. */
  initialPrompt?: string;
  /**
   * Runner id when it is not the provider's own — how a custom runner is named
   * (`custom-acme`). Resolved against the registry on the machine that launches it.
   */
  runnerId?: string;
  /**
   * The one moment a cell's permission posture can be chosen.
   *
   * `--dangerously-skip-permissions` and its siblings are process arguments, so a cell
   * already running cannot be turned back (ADR-8 in `plans/lotus-pocket`). Absent keeps
   * the runner's own default, which is what every caller before the phone relied on.
   *
   * **A {@link PermissionMode} or a stop id from {@link TunedRunner.permissions}.** Typed
   * open rather than as a union of every id, because the ids belong to the CLIs and this
   * field is forwarded by three hosts that do not all know the same ones; the route that
   * accepts it is where the check lives (`cell-routes.ts`), and the runner's own scale is
   * what it checks against.
   */
  permissionMode?: PermissionMode | string;
  /**
   * `spawn-tuning`: a model alias and an effort from the runner's own scale, both as
   * `bootstrap.runners[]` advertised them. Absent keeps the CLI's defaults.
   */
  model?: string;
  effort?: string;
  /** Claude only: the account to run as, from `runners[].profiles`; absent = the host's chosen one. */
  profileId?: string;
}

export interface SpawnCellResponse {
  paneId: string;
  workspaceId?: string;
  cwd?: string;
  sessionId?: string | null;
  provider?: string;
}

export interface DispatchRequest {
  paneId: string;
  command: string;
  /** Append `\n` so the cell executes on submit. Default true. */
  appendNewline?: boolean;
}

export interface DispatchResponse {
  paneId: string;
  bytesWritten: number;
  /** Last 1 KB of cell output captured immediately after the write. */
  tailPreview: string;
}

// ─── Workspaces ───────────────────────────────────────────────────────────────

export interface WorkspaceSummary {
  workspaceId: string;
  cellCount: number;
  /** Sorted unique providers across all cells in this workspace. */
  providers: BridgeProvider[];
}

export interface ListWorkspacesResponse {
  items: WorkspaceSummary[];
}

/**
 * One project the host knows about — **running or not**.
 *
 * Deliberately not the same thing as {@link WorkspaceSummary}, which is a grouping
 * of the panes that happen to be alive right now and therefore cannot represent a
 * project whose agents have all ended. A mobile client that lists only workspaces
 * loses a project the moment its last agent exits, which is the failure ADR-14
 * (`plans/lotus-pocket`) exists to fix.
 *
 * `workspaceId` uses the same key a cell reports, so joining the two lists is a
 * string comparison rather than a guess.
 */
export interface ProjectSummary {
  workspaceId: string;
  /** Alias when the operator set one, otherwise the root directory's last segment. */
  name: string;
  path: string;
  /** Epoch ms. Orders the dormant projects — most recently opened first. */
  lastOpenedAt: number;
}

export interface ListProjectsResponse {
  items: ProjectSummary[];
}

/**
 * What `GET /api/projects` answers, which depends on who is answering.
 *
 * A Standalone Host returns a bare `HostedProject[]` from its `PROJECTS_ROOT`
 * scan; a Lotus desktop returns `{ items: ProjectSummary[] }` from its CodeCanvas
 * registry, carrying the `workspaceId` its cells report and a `lastOpenedAt` a
 * directory scan cannot know. Both are correct for what they are, so the union is
 * named here rather than flattened in the client — flattening would make the type
 * a lie on one of the two hosts. Callers normalise where they know which they want
 * (today: the mobile adapter's `/m/bootstrap`).
 */
export type ProjectListing = HostedProject[] | ListProjectsResponse;

export type { TranscriptEntry, TranscriptResponse } from "./transcript.js";

/** One option a permission prompt is offering, read from the terminal. */
