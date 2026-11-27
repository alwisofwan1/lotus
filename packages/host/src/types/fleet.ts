// ─── Fleet (Bridge MCP) ───────────────────────────────────────────────────────

import type { BridgeProvider } from "./api.js";
import type { ProviderUsage } from "./provider-bridge.js";
import type { HostedProject } from "./projects.js";

/** Keep fields after isAlive optional for older desktops and mirror the Rust fleet.rs contract. */
export interface FleetMember {
  paneId: string;
  workspaceId: string;
  /** Provider currently driving the cell — the Rust side's `provider`. */
  agentType: BridgeProvider;
  /** Display the runner label separately because agentType groups custom runners by protocol family. */
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

  /** Include the hook state in snapshots so reconnecting clients can discover pending input. */
  turn?: string;
  /** Age of {@link FleetMember.turn} in ms — a stale signal reads differently. */
  turnAgeMs?: number;

  /** Report the account selected at launch because a running cell cannot switch accounts. */
  profileId?: string;

  /** Report quota per cell because it is only observed in that cell's stream. */
  usage?: ProviderUsage;

  /** Treat missing gating as unknown because a custom command may bypass permissions (ADR-8). */
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

/** Keep the two legacy modes named because MCP and the desktop bridge still use that vocabulary. */
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
  /** Select a runner-supported mode at launch because process flags cannot be changed afterward (ADR-8, plans/lotus-pocket). */
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

/** List projects independently of live panes so they remain visible after the last agent exits (ADR-14, plans/lotus-pocket). */
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

/** Preserve both response shapes so callers can normalize with knowledge of the host. */
export type ProjectListing = HostedProject[] | ListProjectsResponse;

export type { TranscriptEntry, TranscriptResponse } from "./transcript.js";

/** One option a permission prompt is offering, read from the terminal. */
