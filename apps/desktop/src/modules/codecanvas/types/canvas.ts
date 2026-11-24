import type { ReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";
import type { AgentTerminalPromotionPayload } from "../services/agent-terminal-promotion";
import type { DispatchCanvasNodeCommand } from "../services/nodes/canvas-node-command";

export interface CanvasSnapshot {
  schemaVersion: 1;
  id: string;
  rootDir: string;
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
  terminalCounter?: number;
  agentCounter?: number;
  noteCounter?: number;
  browserCounter?: number;
  shapeCounter?: number;
}

/**
 * Frame membership (ADR-0050): one optional reference to a Frame node, on EVERY non-Frame record
 * kind. Positions stay absolute; there is no ReactFlow `parentId`. One Frame per node, no nesting.
 */
export interface CanvasFrameRef {
  frameId?: string;
  /**
   * The Lotus task an agent spawned this cell for (MCP `lotus_spawn_cell` `task`). Stamped at spawn so
   * the Frame Suggestion can group cells "spawned for the same task" (decision 26), also after reload.
   */
  spawnTaskKey?: string;
  /** The task's title at spawn time: the suggested Frame's name. */
  spawnTaskTitle?: string;
}

/** A Frame: a named, coloured region painted behind its members (array order). Persisted. */
export interface CanvasFrameNodeRecord {
  type: "frame";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  title: string;
  /** Named palette colour id; absent = the default tint. */
  colorId?: string;
  /** Set when this Frame replaced an agent-drawn diagram's frame rect, so edit-in-place still finds the diagram. */
  diagramId?: string;
  /** Id of the Lotus task whose agent-spawned cells this Frame groups; lets later spawns find it after reload. */
  taskKey?: string;
}

export type CanvasMemberNodeRecord = (
  | CanvasTerminalNodeRecord
  | CanvasNoteNodeRecord
  | CanvasAgentNodeRecord
  | CanvasTeamNodeRecord
  | CanvasPlanNodeRecord
  | CanvasRunNodeRecord
  | CanvasTaskNodeRecord
  | CanvasContextNodeRecord
  | CanvasCriticNodeRecord
  | CanvasHumanGateNodeRecord
  | CanvasBrowserNodeRecord
  | CanvasShapeNodeRecord
  | CanvasMusicNodeRecord
  | CanvasHostCellNodeRecord
  | CanvasFactoryNodeRecord
  | CanvasFileNodeRecord
) & CanvasFrameRef;

export type CanvasNodeRecord = CanvasMemberNodeRecord | CanvasFrameNodeRecord;

/** Task lifecycle, mirroring the backend BridgeTaskStatus. */
export type CanvasTaskStatus = "todo" | "in-progress" | "blocked" | "in-review" | "complete" | "cancelled";
export type CanvasTaskPriority = "none" | "low" | "medium" | "high";

/** Which dispatch path a task takes: one autonomous agent, or a coordinated team. */
export type TaskDispatchMode = "single" | "team";

/** Complexity/effort class of a task, used by AI and humans to triage scope. */
export type TaskClass = "quick" | "needs-research" | "deep-focus" | "benchmark";
/** Scheduling priority of a task — when it should be addressed. */
export type TaskWhen = "urgent" | "this-week" | "this-month" | "whenever";

/** A verifiable done-condition on a Canvas Task Node, produced by Smart Convert. */
export interface AcceptanceCriterion {
  id: string;
  text: string;
  done: boolean;
}

/** Structured task draft produced by Smart Convert from a Rich Markdown Note. */
export interface SmartConvertDraft {
  title: string;
  intent: string;
  acceptanceCriteria: AcceptanceCriterion[];
  taskClass: TaskClass;
  when: TaskWhen;
  subtasks: string[];
}

/** A Task node: a unit of work that dispatches to agent(s) on the canvas. Persisted. */
export interface CanvasTaskNodeRecord {
  type: "task";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  title: string;
  description: string;
  status: CanvasTaskStatus;
  priority: CanvasTaskPriority;
  /** Backend BridgeTask id once persisted, or undefined for canvas-only tasks. */
  taskId?: string;
  /** The BridgeTask's workspace: a task is addressed by workspace + id, so a linked node needs both. */
  taskWorkspaceId?: string;
  /** Agent node ids spawned by the last dispatch, for status roll-up. */
  dispatchedAgentIds?: string[];
  /** AI-clarified goal from Smart Convert. */
  intent?: string;
  /** Complexity class assigned by Smart Convert or manually. */
  taskClass?: TaskClass;
  /** Scheduling signal assigned by Smart Convert or manually. */
  when?: TaskWhen;
  /** Verifiable done-conditions from Smart Convert. */
  acceptanceCriteria?: AcceptanceCriterion[];
}

export interface TaskNodePatch {
  title?: string;
  description?: string;
  status?: CanvasTaskStatus;
  priority?: CanvasTaskPriority;
  taskId?: string;
  taskWorkspaceId?: string;
  dispatchedAgentIds?: string[];
  intent?: string;
  taskClass?: TaskClass;
  when?: TaskWhen;
  acceptanceCriteria?: AcceptanceCriterion[];
}

export interface CanvasTaskNodeData {
  title: string;
  description: string;
  status: CanvasTaskStatus;
  priority: CanvasTaskPriority;
  cwd: string;
  taskId?: string;
  taskWorkspaceId?: string;
  dispatchedAgentIds?: string[];
  intent?: string;
  taskClass?: TaskClass;
  when?: TaskWhen;
  acceptanceCriteria?: AcceptanceCriterion[];
  /** Preferred narrow node command seam. Legacy callbacks remain during migration. */
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  onChange?: (nodeId: string, patch: TaskNodePatch) => void;
  onDispatch?: (nodeId: string, mode: TaskDispatchMode, runner?: import("@/lib/agent-runtime").AgentRunnerType, runnerCommand?: string) => void;
  [key: string]: unknown;
}

/**
 * A Context node: the visual surface of one Shared Context Bus. Agents wired in
 * (data-flow) publish artifacts; agents wired out (context) read them. Only the
 * bus title is persisted here — artifacts live in the Context Bus store/registry.
 */
export interface CanvasContextNodeRecord {
  type: "context";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  title: string;
}

export interface ContextNodePatch {
  title?: string;
}

export interface CanvasContextNodeData {
  title: string;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  onChange?: (nodeId: string, patch: ContextNodePatch) => void;
  [key: string]: unknown;
}

/**
 * A Music node: the CodeCanvas YouTube tracklist player. The tracklist itself is
 * GLOBAL (music-tracklist-store, localStorage) — only playback state is persisted
 * per node so a canvas reopens on the same track/volume.
 */
export interface CanvasMusicNodeRecord {
  type: "music";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  /** Track id in the global tracklist that was last active in this node. */
  activeTrackId?: string;
  /** 0..100 (YouTube volume scale). */
  volume?: number;
}

/**
 * A Host Cell node: a cell the project's machine runs **without a terminal**, shown as its
 * conversation (ticket 12, `plans/codecanvas-vps-connector/issues/12`).
 *
 * The counterpart to an adopted Terminal node, and a separate type because there is nothing to
 * attach to. A cell the phone started with `tui:false` is run by the host's `StructuredSessions`
 * in memory: no PTY, no tmux session, no bytes. An xterm pointed at it would be an empty box
 * beside a working agent — a node that looks adopted and is not.
 *
 * Nothing about the conversation is persisted. The host owns the turns, and it is the only thing
 * that can still be right about them after a restart; the node stores only what it needs to ask
 * again.
 */
export interface CanvasHostCellNodeRecord {
  type: "host-cell";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  /** The host's pane id. Without it the node cannot find its cell again — it is the whole record. */
  adoptedPaneId: string;
  /** That machine's directory for the cell, shown in the header; not a path on this machine. */
  cwd: string;
  /** What to call it: the host's `displayName`, else the directory it runs in. */
  label: string;
  /** Runner family the host reported (`claude`, `codex`, …), for the glyph before a page arrives. */
  provider: string;
}

export interface CanvasHostCellNodeData {
  adoptedPaneId: string;
  cwd: string;
  label: string;
  provider: string;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  [key: string]: unknown;
}

/**
 * A Factory node: one ticket's Factory Run, shown live (#146) — a GitHub issue, or a Notion ticket (#168).
 *
 * It keeps the issue, not the run. Try again makes a new run for the same issue, and the node
 * follows it; the run itself is read from the graph-run records, never stored here. The title is
 * kept only so the node still says what it is when the runs cannot be read.
 */
export interface CanvasFactoryNodeRecord {
  type: "factory";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  /** `owner/name`. */
  repo: string;
  /** The issue number, or the Notion ticket id (`TKT-123`). */
  issue: number | string;
  title: string;
}

export interface CanvasFactoryNodeData {
  repo: string;
  issue: number | string;
  title: string;
  [key: string]: unknown;
}

/**
 * A File Node: one project file shown read-only and live on the board (plans/canvas-code, S3).
 *
 * It keeps the PATH, never the contents: the text is read from disk (and watched) while the node
 * is on screen. `path` is absolute and `/`-separated, the spelling the editor file index returns.
 */
export interface CanvasFileNodeRecord {
  type: "file";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  path: string;
  /** First visible line (0-based) so a reopened board scrolls back to where it was. */
  viewport?: { topLine: number };
}

/** The only File Node field that changes after creation: where it is scrolled to. */
export interface FileNodePatch {
  viewport?: { topLine: number };
}

export interface CanvasFileNodeData {
  path: string;
  viewport?: { topLine: number };
  dispatchCommand?: DispatchCanvasNodeCommand;
  [key: string]: unknown;
}

/** Note fields that are not its markdown content (ADR-0046). `null` removes the cover. */
export interface NoteNodePatch {
  coverUri?: string | null;
}

export interface MusicNodePatch {
  activeTrackId?: string;
  volume?: number;
}

export interface CanvasMusicNodeData {
  activeTrackId?: string;
  volume?: number;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  onChange?: (nodeId: string, patch: MusicNodePatch) => void;
  [key: string]: unknown;
}

/**
 * A Critic node: a skeptical verifier that gates downstream nodes (N4). It runs like an
 * agent on the upstream output and emits a boolean verdict; a FAIL closes the gate. Only the
 * bus title/model are persisted — its verdict is per-run state, not snapshot.
 */
export interface CanvasCriticNodeRecord {
  type: "critic";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  title: string;
  model?: string;
}

export interface CriticNodePatch {
  title?: string;
  model?: string;
}

export interface CanvasCriticNodeData {
  title: string;
  cwd: string;
  model: string;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  onChange?: (nodeId: string, patch: CriticNodePatch) => void;
  [key: string]: unknown;
}

export type CanvasHumanGateKind = "clarification" | "approval";
export type CanvasHumanGateStatus = "idle" | "waiting" | "approved" | "rejected";

/** A Human Gate node: pauses a Workflow Run until the user approves or rejects it. */
export interface CanvasHumanGateNodeRecord {
  type: "human-gate";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  title: string;
  instructions: string;
  gateKind: CanvasHumanGateKind;
  status: CanvasHumanGateStatus;
}

export interface HumanGateNodePatch {
  title?: string;
  instructions?: string;
  gateKind?: CanvasHumanGateKind;
  status?: CanvasHumanGateStatus;
  waitingSince?: number;
}

export interface CanvasHumanGateNodeData {
  title: string;
  instructions: string;
  gateKind: CanvasHumanGateKind;
  status: CanvasHumanGateStatus;
  /** When the gate started waiting (epoch ms); set with `status: "waiting"`, cleared on a decision. Not persisted. */
  waitingSince?: number;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  onChange?: (nodeId: string, patch: HumanGateNodePatch) => void;
  [key: string]: unknown;
}

/** One step of a Plan node. owner = agent name for live status. */
export interface CanvasPlanStep {
  title: string;
  owner?: string;
  done?: boolean;
}

/** Durable manual bindings from a plan owner label to the agent node id that owns it. */
export type CanvasOwnerBindings = Record<string, string>;

/** A Plan node: a step checklist that mirrors the agent team's live progress. Persisted. */
export interface CanvasPlanNodeRecord {
  type: "plan";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  title: string;
  steps: CanvasPlanStep[];
  /** Owner-label → agent node id overrides, authoritative over name resolution. */
  ownerBindings?: CanvasOwnerBindings;
}

/**
 * A Run Node: one graph run over its member nodes (plans/canvas-graph-run). Membership is data
 * here, never React Flow `parentId`. Run status lives in the run record, never on the node.
 */
export interface CanvasRunNodeRecord {
  type: "run";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  title: string;
  memberIds: string[];
  /** The run's goal — typed into each live agent as its step (empty until the user writes one). */
  brief?: string;
  /** USD limit per run; reaching it pauses the run. Absent = no cap. */
  budgetCap?: number;
  /** Drawn as an outline around its members instead of the card (#74). Absent = closed. */
  open?: boolean;
}

export interface CanvasRunNodeData {
  title: string;
  memberIds: string[];
  brief?: string;
  budgetCap?: number;
  open?: boolean;
  /** Active canvas project — run records are filed under it. Injected, never persisted. */
  projectId?: string | null;
  dispatchCommand?: DispatchCanvasNodeCommand;
  [key: string]: unknown;
}

export interface CanvasPlanNodeData {
  title: string;
  steps: CanvasPlanStep[];
  cwd: string;
  ownerBindings?: CanvasOwnerBindings;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  onPlanChange?: (nodeId: string, patch: PlanNodePatch) => void;
  [key: string]: unknown;
}

/** Fields a Run Node's card may edit in place. */
export interface RunNodePatch {
  title?: string;
  brief?: string;
  /** `undefined` removes the cap. */
  budgetCap?: number;
  /** Changed by dragging a node into or out of the open group (#74). */
  memberIds?: string[];
  open?: boolean;
}

export interface PlanNodePatch {
  title?: string;
  steps?: CanvasPlanStep[];
  ownerBindings?: CanvasOwnerBindings;
}

export interface CanvasNodePosition {
  x: number;
  y: number;
}

export interface CanvasNodeSize {
  w: number;
  h: number;
}

export interface TerminalNodePatch {
  label?: string;
  cwd?: string;
  assignedWorktree?: string | null;
  assignedWorktreePath?: string | null;
}

export interface CanvasTerminalNodeRecord {
  type: "terminal";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  /** Last known working directory. Falls back to canvas rootDir on reload. */
  cwd: string;
  /** Sequential display number: "Terminal N". Monotonically increasing, persisted. */
  terminalNumber: number;
  /** Optional user-facing name. The stable "Terminal N" identity remains an addressing alias. */
  label?: string;
  /** Currently assigned git worktree branch, or null. */
  assignedWorktree: string | null;
  /** Absolute path to the assigned worktree directory. Null when no worktree is assigned. */
  assignedWorktreePath?: string | null;
  /** Base branch the assigned worktree was branched from (diff/merge target). ADR 0015. */
  baseBranch?: string | null;
  /**
   * The host pane id this terminal adopted, when it did (ticket 11).
   *
   * Present means the node starts nothing: it runs `tmux attach` against the session the machine's
   * Standalone Host gave that cell. Persisted because a reload without it produces a node that
   * looks identical and behaves like an ordinary terminal — a fresh shell beside the agent, rather
   * than a window onto it.
   */
  adoptedPaneId?: string;
}

export interface CanvasNoteNodeRecord {
  type: "note";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  content: string;
  noteNumber?: number;
  /** Epoch ms of the last content change — the footer's "Edited …" line (ADR-0046). */
  editedAt?: number;
  /** `lotus-note-asset://<id>` of the cover image. A plain string in the snapshot, so the Rust
   * note-asset GC (which scans every string) keeps the asset alive (ADR-0014). */
  coverUri?: string;
  /** Display name of the agent that wrote the last change (ADR-0047); absent after a user edit. */
  editedBy?: string;
}

export interface CanvasEdgeRecord {
  id: string;
  source: string;
  target: string;
  /** Semantic wire kind. "browser-spawn" = dashed edge from TerminalNode to BrowserNode. */
  kind?: string;
  /** User-set label override. Empty string = explicitly no label (suppresses kind default). */
  label?: string;
  /** Side-handle ids each end attaches to (4-side handles), omitted for default attachment. */
  sourceHandle?: string;
  targetHandle?: string;
}

// ─── Browser Node ─────────────────────────────────────────────────────────────

export type CanvasBrowserState = "active" | "disconnected" | "loading";
export type CanvasBrowserViewportMode = "auto" | "desktop" | "tablet" | "mobile" | "custom";
export type CanvasBrowserViewportPreset = "desktop" | "tablet" | "mobile" | "custom";
export type CanvasBrowserOrientation = "landscape" | "portrait";
export type CanvasBrowserScaleMode = "fit" | "actual" | "fill";

/**
 * A Canvas Browser Node: a Tauri native WebView displaying a live URL.
 * Spawned by a Canvas Terminal Node (user or agent). At most one per terminal.
 * Partially persisted: URL saved, WebView starts disconnected on restore.
 */
export interface CanvasBrowserNodeRecord {
  type: "browser";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  /** ReactFlow node ID of the spawning Canvas Terminal Node. null for standalone browsers. */
  parentTerminalId: string | null;
  /** Last known URL — persisted so the node can reconnect to the same URL. */
  url: string;
  /** "disconnected" when restored from snapshot (WebView not yet open). */
  state: CanvasBrowserState;
  /** Sequential display number: "Browser N". */
  browserNumber: number;
  /** Optional user-facing name used by NL, voice, and agents. Falls back to "Browser N". */
  label?: string;
  /** Responsive viewport mode for browser chrome and agent snapshots. Defaults to auto. */
  viewportMode?: CanvasBrowserViewportMode;
  /** Last explicit viewport orientation. Auto may infer when omitted. */
  viewportOrientation?: CanvasBrowserOrientation;
  /** Custom viewport width, used only when viewportMode is custom. */
  viewportWidth?: number;
  /** Custom viewport height, used only when viewportMode is custom. */
  viewportHeight?: number;
  /** How the emulated viewport should fit inside the node shell. Defaults to fit. */
  viewportScaleMode?: CanvasBrowserScaleMode;
  /** Manual native browser zoom factor. Omitted/null lets fit mode recalculate from node size. */
  viewportZoom?: number | null;
}

export interface BrowserNodePatch {
  url?: string;
  state?: CanvasBrowserState;
  label?: string;
  pageTitle?: string;
  viewportMode?: CanvasBrowserViewportMode;
  viewportOrientation?: CanvasBrowserOrientation;
  viewportWidth?: number;
  viewportHeight?: number;
  viewportScaleMode?: CanvasBrowserScaleMode;
  viewportZoom?: number | null;
}

export interface CanvasBrowserNodeData {
  parentTerminalId: string | null;
  /** Runtime pane ID for terminal writes; differs from parentTerminalId in project-scoped Canvas boards. */
  parentRuntimePaneId?: string | null;
  url: string;
  state: CanvasBrowserState;
  browserNumber: number;
  label?: string;
  pageTitle?: string;
  viewportMode?: CanvasBrowserViewportMode;
  viewportOrientation?: CanvasBrowserOrientation;
  viewportWidth?: number;
  viewportHeight?: number;
  viewportScaleMode?: CanvasBrowserScaleMode;
  viewportZoom?: number | null;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  onNavigate?: (nodeId: string, url: string) => void;
  onConnect?: (nodeId: string) => void;
  [key: string]: unknown;
}

// ─── Whiteboard Shape Node (hand-drawn, Excalidraw-style) ─────────────────────

/**
 * Drawable shape kinds. The tool rail creates the hand-drawn kinds; `image` is created by
 * pasting/dropping a raster image onto empty canvas (Excalidraw-style image element) — it renders
 * a bitmap instead of rough.js geometry but shares the shape node's move/resize/group/arrange model.
 */
export type CanvasShapeKind = "rectangle" | "diamond" | "ellipse" | "text" | "arrow" | "line" | "draw" | "image";
export type CanvasStrokeStyle = "solid" | "dashed" | "dotted";

/** Persisted visual style of a shape — edited via the Inspector panel (PR3). */
export interface CanvasShapeStyle {
  strokeColor?: string;
  strokeWidth?: number;
  strokeStyle?: CanvasStrokeStyle;
  sloppiness?: "architect" | "artist" | "cartoonist";
  /** 0..100. */
  opacity?: number;
  fill?: string;
  /** Background fill texture (rough.js). Only meaningful when `fill` is set. */
  fillStyle?: "solid" | "hachure" | "cross-hatch";
  /** Text-shape typography. */
  fontFamily?: "hand" | "normal" | "heading" | "code";
  fontSize?: "S" | "M" | "L" | "XL";
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  /** Continuous multiplier on the tier font size — driven by corner-resizing a text element. */
  fontScale?: number;
  /** Linear-shape (arrow/line) geometry + endpoints. */
  arrowType?: "straight" | "curved" | "elbow";
  startArrowhead?: CanvasArrowhead;
  endArrowhead?: CanvasArrowhead;
}

export type CanvasArrowhead = "none" | "arrow" | "triangle" | "dot";

/**
 * A whiteboard shape node (rectangle/diamond/ellipse/text), rendered hand-drawn via
 * rough.js. Pure annotation — excluded from the workflow execution graph (PRD §10).
 */
export interface CanvasShapeNodeRecord {
  type: "shape";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  shape: CanvasShapeKind;
  text?: string;
  /** Rotation in degrees clockwise around the box center; absent = upright (0). */
  angle?: number;
  /** Optional area label shown on container-style shapes. */
  areaLabel?: string;
  /** Endpoints for linear shapes (arrow/line), normalized 0..1 within the node box. */
  points?: Array<[number, number]>;
  style?: CanvasShapeStyle;
  shapeNumber?: number;
  /**
   * Image shape only. The durable `lotus-note-asset://<id>` URI of the bitmap (bytes live in the
   * note-asset store). Persisted verbatim so the Rust GC — which scans the snapshot for that URI —
   * keeps the asset. An image shape without this is unrenderable and dropped on decode.
   */
  imageAssetUri?: string;
  /** Image shape only — accessible alt text derived from the source file name. */
  imageAlt?: string;
  /** Image shape only — intrinsic pixel dimensions, kept so resize can lock the true aspect ratio. */
  imageNaturalWidth?: number;
  imageNaturalHeight?: number;
  /**
   * @deprecated Legacy Excalidraw-style group ids (outermost last). Read only by the load-time
   * migration, which turns each outermost group into a Frame (`frameId`). Never written any more.
   */
  groupIds?: string[];
  /** Agent-drawn diagram marks: lets edit-in-place find a diagram after reload. */
  diagramId?: string;
  diagramFrame?: boolean;
  diagramNodeId?: string;
}

export interface ShapeNodePatch {
  text?: string;
  areaLabel?: string;
  /** Rotation in degrees clockwise (rotate handle / Inspector). */
  angle?: number;
  style?: CanvasShapeStyle;
  /** Updated endpoints for linear/freehand shapes (point editing). */
  points?: Array<[number, number]>;
}

export interface CanvasShapeNodeData {
  shape: CanvasShapeKind;
  text?: string;
  /** Rotation in degrees clockwise around the box center; absent = upright (0). */
  angle?: number;
  areaLabel?: string;
  points?: Array<[number, number]>;
  style?: CanvasShapeStyle;
  shapeNumber?: number;
  /** Image shape — see CanvasShapeNodeRecord for field semantics. */
  imageAssetUri?: string;
  imageAlt?: string;
  imageNaturalWidth?: number;
  imageNaturalHeight?: number;
  /** Legacy group ids, present only until the load-time migration strips them (see CanvasShapeNodeRecord.groupIds). */
  groupIds?: string[];
  /** Agent-drawn diagram marks: lets edit-in-place find a diagram after reload. */
  diagramId?: string;
  diagramFrame?: boolean;
  diagramNodeId?: string;
  /** Runtime-only: bump to a fresh value to ask the node to open its text editor (text tool over
   *  an existing shape). Never persisted — the snapshot codec drops unknown shape fields on load. */
  editRequestId?: number;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  onChange?: (nodeId: string, patch: ShapeNodePatch) => void;
  [key: string]: unknown;
}

/**
 * Live status of a Canvas Agent Node. Derived from the stream, never persisted.
 *
 * `needs-you` means a human is required before the agent can continue — a permission prompt or a
 * question. It is the one member that is **never inferred**: it comes only from a hook fact
 * (`turn: "needs-input"`, see `agent-status-resolve.ts`). No timer, no output pattern and no
 * prompt-string match may produce it — `scripts/agent-notify/run-hook.mjs` argues that case at
 * length for the demotion direction, and it holds just as firmly for promotion.
 *
 * Not to be confused with a **Task Blocker** (`CONTEXT.md`), which is a Swarm task lifecycle state.
 * This is one agent pane's turn state.
 */
export type AgentNodeStatus =
  | "idle"
  | "connecting"
  | "running"
  | "needs-you"
  | "completed"
  | "error"
  | "stalled";

/** Reusable agent template managed in Canvas Settings. App-level, shared across projects. */
export interface AgentDefinition {
  id: string;
  name: string;
  role?: string;
  model: string;
  prompt: string;
  appliedSkills: string[];
  /**
   * How hard this agent thinks.
   *
   * A level from `lib/agent-runtime/reasoning-effort.ts`, not a free string: that scale is what
   * the CLIs actually accept, and the comment here used to say "minimal..max" — a range whose
   * lowest value Claude ignores with a warning. Values read from a saved canvas go through
   * `normalizeReasoningLevel` first, so a file written before this was tightened still opens.
   */
  effort?: ReasoningLevel;
  /** "full" = skip permissions (can write); "safe" = keep permissions (read-only). Default "full". */
  permissionMode?: string;
  /** CLI runner type. Omitted = "claude". */
  runner?: import("@/lib/agent-runtime").AgentRunnerType;
  /** Required when runner = "custom". The exact command string to exec in the PTY. */
  runnerCommand?: string;
  /** Persona accent colour (hex) shown on the live header badge. Omitted = default runner tint. */
  color?: string;
  updatedAt: number;
}

/** A canvas node that instantiates an AgentDefinition and runs it headless. Persisted. */
export interface CanvasAgentNodeRecord {
  type: "agent";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  cwd: string;
  agentNumber: number;
  agentDefId: string;
  /** Cached from the definition at create time so the node stays runnable if the definition changes/deletes. */
  name: string;
  model: string;
  prompt: string;
  /** live = interactive PTY persona; headless = one-shot graph worker. Default headless on load (ADR-0022). */
  executionMode?: "headless" | "live";
  /** CLI runner cached from the definition; resolved by the Agent Runtime Kernel on live spawn (ADR-0023). */
  runner?: import("@/lib/agent-runtime").AgentRunnerType;
  /** Full launch command for a `custom` runner; the kernel needs it to spawn (persisted for reload). */
  runnerCommand?: string;
  /** Persona accent colour cached from the definition (hex). */
  color?: string;
  /** Skill names applied to this agent (injected into the run prompt). */
  appliedSkills?: string[];
  /** Per-agent governance, cached from the definition. */
  effort?: ReasoningLevel;
  permissionMode?: string;
  /** Assigned worktree branch — persisted so the agent resumes in the right tree. */
  assignedWorktree?: string | null;
  /** Absolute path of the assigned worktree directory. */
  assignedWorktreePath?: string | null;
  /** Base branch the assigned worktree was branched from (diff/merge target). ADR 0015. */
  baseBranch?: string | null;
  /** Prior runner session id, captured on close; relaunched via the runner's resume flag on reopen (ADR-0027 Phase 5). */
  resumeSessionId?: string | null;
  /** Claude account the live agent runs on (issues/07); absent = the globally chosen one. Claude runner only. */
  account?: string | null;
}

/** In-memory data for a Canvas Agent Node (callbacks injected at render). */
export interface CanvasTeamNodeRecord {
  type: "team";
  id: string;
  position: CanvasNodePosition;
  size: CanvasNodeSize;
  cwd: string;
  teamId?: string;
  name: string;
  description: string;
  goal: string;
  members: AgentDefinition[];
}

export interface TeamNodePatch {
  name?: string;
  description?: string;
  goal?: string;
  members?: AgentDefinition[];
}

export interface CanvasTeamNodeData {
  cwd: string;
  teamId?: string;
  name: string;
  description: string;
  goal: string;
  members: AgentDefinition[];
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  onChange?: (nodeId: string, patch: TeamNodePatch) => void;
  [key: string]: unknown;
}

export interface CanvasAgentNodeData {
  agentDefId: string;
  name: string;
  model: string;
  cwd: string;
  prompt: string;
  /** live = interactive PTY persona; headless = one-shot graph worker (ADR-0022). */
  executionMode?: "headless" | "live";
  /** CLI runner cached from the definition; resolved by the Agent Runtime Kernel on live spawn (ADR-0023). */
  runner?: import("@/lib/agent-runtime").AgentRunnerType;
  /** Full launch command for a `custom` runner; the kernel needs it to spawn (persisted for reload). */
  runnerCommand?: string;
  /** Persona accent colour cached from the definition (hex). */
  color?: string;
  /** Task to auto-submit once a live persona is ready (seeded on task dispatch); transient. */
  initialTask?: string;
  /** Active CodeCanvas project id, injected at render for project-memory prompt context. */
  projectId?: string | null;
  appliedSkills?: string[];
  effort?: ReasoningLevel;
  permissionMode?: string;
  /** Prior runner session id; relaunched via the runner's resume flag on reopen (ADR-0027 Phase 5). */
  resumeSessionId?: string | null;
  /** Claude account the live agent runs on (issues/07); absent = the globally chosen one. Claude runner only. */
  account?: string | null;
  /**
   * Persists a freshly minted session id onto the node so the next reopen resumes it (ADR-0027
   * Phase 5).
   *
   * Resolves **false** when that id already belongs to another node in this project — two agents in
   * one cwd can diff up the same fresh transcript, and the loser must keep looking rather than
   * adopt a conversation it does not own (Session Widget, Slice 07). Anything else means the id was
   * accepted; a caller may treat `undefined` (a listener that predates this contract) as accepted.
   */
  onPersistSession?: (nodeId: string, sessionId: string) => void | Promise<boolean>;
  /**
   * Point this node at a different conversation and relaunch its runner against it
   * (`plans/codecanvas-session-widget/`, Slice 04). `null` starts a fresh conversation.
   *
   * Separate from {@link CanvasAgentNodeData.onPersistSession} on purpose: that one records an id
   * the CLI just created, while this is a deliberate switch — and switching away from a session
   * must leave it resumable, never mark it dead.
   */
  onSwitchSession?: (nodeId: string, providerSessionId: string | null) => void;
  /** Move this Claude node to another account; the node relaunches and resumes its conversation there. */
  onSwitchAccount?: (nodeId: string, account: string) => void;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  /** Spawns/focuses a Canvas Skills Node wired to this agent (Skills action). */
  onAddSkillsNode?: (agentId: string, cwd: string) => void;
  /** True when a Canvas Skills Node is already wired to this agent. */
  hasSkillsNode?: boolean;
  /** Creates a supervised Canvas Terminal Node from this agent's current run configuration. */
  onPromoteToTerminal?: (agentId: string, payload: AgentTerminalPromotionPayload) => void;
  [key: string]: unknown;
}

/** In-memory data for a Canvas Skills Node (the skill list). Session-only. */
export interface CanvasSkillPreview {
  name: string;
  source: "project" | "global";
  content: string;
  description?: string;
  path?: string;
  metadata?: Array<{ key: string; value: string }>;
}

export interface CanvasSkillsNodeData {
  parentTerminalId: string;
  cwd: string;
  /** Parent node's CLI runner — decides the skill token (`/teach` for Claude, `$teach` for Codex).
   *  Injected by canvas-flow-config; omitted (a plain Terminal) means Claude's `/`. */
  parentRunner?: import("@/lib/agent-runtime").AgentRunnerType;
  /** Runner Registry `claudeFamily` flag for a `custom` parent runner. */
  parentClaudeFamily?: boolean;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onOpenSkill?: (skillsNodeId: string, skill: CanvasSkillPreview) => void;
  isSkillApplied: (terminalId: string, skillName: string) => boolean;
  onReEnableSkill?: (terminalId: string, skillName: string) => void;
  onClose?: (nodeId: string) => void;
  [key: string]: unknown;
}

/**
 * In-memory data for a Canvas Skill Node. Session-only — never serialized into a
 * CanvasNodeRecord, so it carries the SKILL.md content directly (sourced from the
 * SkillEntry the panel held at click time).
 */
export interface CanvasSkillNodeData {
  skillName: string;
  source: "project" | "global";
  content: string;
  description?: string;
  path?: string;
  metadata?: Array<{ key: string; value: string }>;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onClose?: (nodeId: string) => void;
  [key: string]: unknown;
}
