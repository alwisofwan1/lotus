// ─── Projects ─────────────────────────────────────────────────────────────────

export type ProjectPolicy = "read-only" | "approval-required" | "trusted-yolo";

export interface HostedProject {
  /** Short slug used as identifier, e.g. "api-service". */
  id: string;
  /** Human-readable label shown in Telegram. */
  name: string;
  /** Absolute filesystem path on the VPS. */
  path: string;
  /** Remote execution policy. Defaults to approval-required. */
  policy?: ProjectPolicy;
}

// ─── Cloning ──────────────────────────────────────────────────────────────────

export interface CloneProjectRequest {
  /** Anything git accepts: https, ssh, or `owner/repo` where `gh` resolves it. */
  url: string;
  /** Empty or absent means the repository's default branch. */
  branch?: string;
  /** Empty or absent means the name derived from the URL. */
  name?: string;
}

export type CloneState = "running" | "done" | "failed";
export type CloneStep = "resolving" | "cloning" | "registering";

export interface CloneJob {
  taskId: string;
  state: CloneState;
  step: CloneStep;
  name: string;
  path: string;
  /** git's own words, unchanged — the host cannot tell a typo from a private repo. */
  error?: string;
}

// ─── Browsing ─────────────────────────────────────────────────────────────────

export interface BrowseRoot {
  name: string;
  path: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
  /** Whether a `.git` sits inside it. A worktree or submodule counts. */
  isRepo: boolean;
  /** The branch, when it could be read without shelling out. Null is *not knowable here*. */
  branch: string | null;
  /** Non-hidden directories inside it — what makes "worth entering" answerable. */
  children: number;
  /** Whether this host already holds it. A row that says so need not guess. */
  isProject: boolean;
}

/** Why the directory on screen cannot be taken. Null means it can. */
export type NotTakeable = "workspace-root" | "already-a-project";

export interface BrowsePage {
  path: string;
  /** Null at a root. There is nothing above it a client may draw a way up to. */
  parent: string | null;
  entries: BrowseEntry[];
  /**
   * Whether *this* directory may be taken as a project.
   *
   * Answered by the host because only it knows: the phone cannot see which root is scanned,
   * and a client that guessed would draw a live button over a request the host refuses.
   */
  takeable: boolean;
  whyNot: NotTakeable | null;
}

export interface BrowseResponse {
  /** Every place this host opens. Always sent, so a client can draw the top level at once. */
  roots: BrowseRoot[];
  /** What was asked for, or null when nothing was — the client is at the top level. */
  page: BrowsePage | null;
}

