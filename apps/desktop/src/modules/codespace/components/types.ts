import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import type { TerminalV2LayoutTree } from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import type { CodespaceGitDiffTarget } from "@/lib/tauri/codespace";

export type CellType = "terminal" | "browser" | "workbench" | "chat";

export type LayoutTemplate = {
  id: string;
  name?: string;
  description?: string;
  sessions: number;
  rows: number;
  cols: number;
  label: string;
};

type BaseCell = {
  id: string;
  cwd: string;
  type: CellType;
};

/**
 * Lifecycle of the auto-generated conversation title:
 *   pending    → agent running, turn 1 not finished yet (no title attempt)
 *   generating → Claude sidecar request in flight
 *   ready      → title text available
 *   failed     → last generation attempt errored; UI falls back to breadcrumb
 *   manual     → typed by a person; nothing automatic replaces it until they choose "automatic"
 */
export type PaneTitleStatus = "pending" | "generating" | "ready" | "failed" | "manual";

export type TerminalCellData = BaseCell & {
  type: "terminal";
  terminalCommand?: string[];
  /** Lotus Claude account this pane runs on (issues/07); absent = the globally chosen one. */
  claudeAccount?: string;
  runtimeSessionId?: string | null;
  runtimeStatus?: TerminalRuntimeStatus;
  agentCommand?: string;
  /** Stable @mention-style routing target allocated from the detected runtime provider. */
  agentAddress?: string;
  /** Previous routing addresses kept as aliases after provider promotion. */
  legacyAgentAddresses?: string[];
  /** Provider detected from the live runtime output, after spawn. */
  runtimeProvider?: ExecutorProviderId;
  /**
   * System-allocated human name (`Nara`, `Bima`) drawn once from the locale name pool at
   * spawn (or promotion from shell) and persisted with the cell — never recomputed per
   * render, so it stays stable across restarts. A rename replaces it (ADR-0068); the old name stays
   * reachable as a legacy address.
   */
  agentName?: string;
  /** Marks cells spawned by Bridge task execution so idle watchers can scope completion. */
  cellOrigin?: "bridge-task";
  /** Optional Bridge role pre-baked into the cell (planner/implementer/reviewer/tester/refactor). */
  role?: string;
  /** Auto-generated conversation title (set after turn 1 by the Lotus title generator). */
  title?: string;
  /** Lifecycle of the title generator for this cell. */
  titleStatus?: PaneTitleStatus;
  /** Epoch ms when `title` was last updated — used to debounce refresh requests. */
  titleUpdatedAt?: number;
  /**
   * Which agent conversation `title` names — its transcript path. A pane outlives its
   * conversations (a fresh `claude`, a `/clear`), and a title is only true of the one it was
   * made for: when the key changes, the title is replaced rather than kept.
   */
  titleSessionKey?: string;
};

export type BrowserCellData = BaseCell & {
  type: "browser";
  url: string;
  zoom?: number;
  title?: string;
  loading?: boolean;
  /** The agent pane this browser's element picks go to (plans/code-browser-redesign/PANE-LINK.md). */
  linkedPaneId?: string;
};

/** Pinned tabs sit together at the front of the strip and survive Close others / to the right. */
export type WorkbenchTab =
  /** `preview`: opened by a single click in the tree, so the next such click replaces it. */
  | { id: string; kind: "file"; filePath: string; dirty?: boolean; preview?: boolean; pinned?: boolean }
  | { id: string; kind: "url"; url: string; title?: string; pinned?: boolean }
  /** A file's git diff, or the disk copy against unsaved edits (`"disk"`). Lives with the pane
   * only: never written into the saved workspace. */
  | { id: string; kind: "diff"; filePath: string; target: DiffTabTarget; repoRoot?: string; pinned?: boolean }
  /** One commit of the Git graph (GLOSSARY "Source control"). Not saved, like a diff. */
  | { id: string; kind: "commit"; repoRoot: string; sha: string; subject?: string; pinned?: boolean }
  /** The Git graph opened wide, with columns. Not saved, like a diff. */
  | { id: string; kind: "graph"; repoRoot: string; pinned?: boolean };

/** Tabs that hold a file of the pane's folder. */
export type WorkbenchPathTab = Extract<WorkbenchTab, { filePath: string }>;

export function isPathTab(tab: WorkbenchTab): tab is WorkbenchPathTab {
  return tab.kind === "file" || tab.kind === "diff";
}

export type DiffTabTarget = CodespaceGitDiffTarget | "disk";

export type WorkbenchCellData = BaseCell & {
  type: "workbench";
  rootDir: string;
  tabs: WorkbenchTab[];
  activeTabId: string | null;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
};

export type ExecutorProviderId =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "cursor"
  | "copilot"
  | "grok"
  | "kimi"
  | "pi"
  | "antigravity"
  | "droid"
  | "ccs-hss";
export type PlannerProviderId = "claude-headless" | "ccs-hss-headless" | "codex-headless";
export type ProviderId = ExecutorProviderId | PlannerProviderId;

export type BridgeStatus =
  | "idle"
  | "streaming"
  | "thinking"
  | "dispatching"
  | "awaiting-agents"
  | "verifying"
  | "done"
  | "error"
  | "cancelled";

export type BridgeEvent =
  | { id: string; kind: "user-prompt"; prompt: string; at: number }
  | {
      id: string;
      kind: "assistant-message";
      text: string;
      at: number;
      /**
       * True while the dispatcher is still appending text deltas to this
       * message (between `content_block_start` and `content_block_stop`).
       * False once the block is sealed. Undefined for legacy non-streamed
       * messages emitted from a final `assistant` event.
       */
      streaming?: boolean;
    }
  | {
      id: string;
      kind: "tool-use";
      name: string;
      input?: unknown;
      at: number;
      /** Stream-json `tool_use_id`; lets us pair the result row later. */
      toolUseId?: string;
    }
  | {
      id: string;
      kind: "tool-result";
      /** Matches a prior `tool-use` event's `toolUseId` when available. */
      toolUseId?: string;
      /** Short JSON-ish preview — truncated to ~500 chars. */
      preview: string;
      isError?: boolean;
      at: number;
    }
  | { id: string; kind: "status"; status: BridgeStatus; at: number }
  | { id: string; kind: "error"; message: string; at: number };

/**
 * A conversation, as a pane.
 *
 * It carries the session id and nothing else: the messages, model and mode all belong to the
 * CodeChat session store, which is the single owner after M1.0. Two surfaces showing the same
 * `sessionId` are therefore showing the same thread, not two copies of it.
 */
export type ChatCellData = BaseCell & {
  type: "chat";
  /** The CodeChat session; "" on a new-chat pane. */
  sessionId: string;
  /**
   * New Chat (beta, 07d): the pane runs the new chat instead. `id` is null until the first
   * message creates the thread; `title` is kept for the rail, which does not list threads.
   */
  thread?: { id: string | null; title?: string };
};

export type GridCell =
  | TerminalCellData
  | BrowserCellData
  | WorkbenchCellData
  | ChatCellData;

export type WorkspaceLocation =
  | { kind: "local"; cwd: string }
  | {
      kind: "ssh";
      host: string;
      user?: string;
      port?: number;
      remoteCwd?: string;
      label?: string;
    };

export type WorkspacePaneLayoutMode = "grid" | "focus" | "main-right" | "main-bottom";

export const FRAME_COLORS = ["violet", "teal", "amber", "rose", "blue", "lime"] as const;
export type FrameColor = (typeof FRAME_COLORS)[number];

/** A named set of panes in a Code workspace (GLOSSARY → Frames). Rules: `workspace-shell/services/code-frames.ts`. */
export type CodeFrame = {
  id: string;
  name: string;
  color: FrameColor;
  /** Drives "newest first" on the rail. */
  createdAt: number;
  /** A pane id appears in at most one Frame. */
  paneIds: string[];
  /** This Frame's own split; null while it has no panes. */
  layout: TerminalV2LayoutTree | null;
};

export type WorkspacePaneLayout = {
  mode: WorkspacePaneLayoutMode;
  focusCellId?: string | null;
  terminalV2Layout?: TerminalV2LayoutTree | null;
  frames?: CodeFrame[];
  /** The one-time legacy migration has run for this workspace. */
  framesMigrated?: true;
};

export type Workspace = {
  id: string;
  label: string;
  /**
   * Optional user-friendly slug shown in the right-side badge of agent
   * pane headers. Defaults to the smart-truncated leaf folder name when
   * absent; rename UI lands in slice 5.
   */
  name?: string;
  color: string; // CSS gradient or solid color for the tab
  cwd: string;
  schemaVersion?: number;
  location?: WorkspaceLocation;
  rows: number;
  cols: number;
  rowFractions?: number[];
  colFractions?: number[];
  paneLayout?: WorkspacePaneLayout;
  /** Monotonic provider address counters used by Bridge/MCP fleet routing. */
  agentAddressCounters?: Record<string, number>;
  cells: GridCell[];
};

export type AgentType = {
  id: string;
  name: string;
  command: string;
  description: string;
};

/** The machine a remote preset opens on; `cwd` is then a path on that machine. */
export type PresetRemote = { kind: "ssh"; host: string; user?: string; port?: number };

export type Preset = {
  id: string;
  name: string;
  templateId: string;
  cwd: string;
  agentSlots: Record<string, number>;
  customCommands?: Record<string, string>;
  customCommandNames?: Record<string, string>;
  /** Kept in the wizard's "Jump back in" row ahead of the most recent ones. */
  pinned?: boolean;
  /** Epoch ms of the last launch; orders "Jump back in" and the preset palette. */
  lastOpenedAt?: number;
  /** Absent = this Mac. */
  location?: PresetRemote;
  createdAt: number;
  updatedAt: number;
};

function validRemote(raw: unknown): raw is PresetRemote {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return r.kind === "ssh" && typeof r.host === "string" && r.host.trim() !== ""
    && (r.user === undefined || typeof r.user === "string")
    && (r.port === undefined || typeof r.port === "number");
}

/** Validate a preset from storage. Returns null if invalid. */
export function validatePreset(raw: unknown, validTemplateIds: Set<string>): Preset | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id) return null;
  if (typeof p.name !== "string" || !p.name.trim()) return null;
  if (typeof p.templateId !== "string" || !validTemplateIds.has(p.templateId)) return null;
  if (typeof p.cwd !== "string") return null;
  const agentSlots = (p.agentSlots && typeof p.agentSlots === "object") ? p.agentSlots as Record<string, number> : {};
  const customCommands = (p.customCommands && typeof p.customCommands === "object") ? p.customCommands as Record<string, string> : undefined;
  const customCommandNames = (p.customCommandNames && typeof p.customCommandNames === "object")
    ? p.customCommandNames as Record<string, string>
    : undefined;
  return {
    id: p.id,
    name: p.name.trim(),
    templateId: p.templateId,
    cwd: p.cwd,
    agentSlots,
    customCommands,
    customCommandNames,
    ...(p.pinned === true ? { pinned: true } : {}),
    ...(typeof p.lastOpenedAt === "number" ? { lastOpenedAt: p.lastOpenedAt } : {}),
    ...(validRemote(p.location) ? { location: p.location } : {}),
    createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
    updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : Date.now(),
  };
}

export type WorkspaceConfig = {
  template: LayoutTemplate;
  cwd: string;
  agentCommands: string[];
  cellTypes?: CellType[];
};
