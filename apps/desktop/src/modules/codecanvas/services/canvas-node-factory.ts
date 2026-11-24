import type { Node } from "@xyflow/react";
import type { AcceptanceCriterion, AgentDefinition, CanvasBrowserOrientation, CanvasBrowserScaleMode, CanvasBrowserState, CanvasBrowserViewportMode, CanvasNodeRecord, CanvasPlanStep, CanvasShapeKind, CanvasShapeStyle, CanvasSkillPreview, CanvasTaskPriority, CanvasTaskStatus, TaskClass, TaskWhen } from "../types/canvas";
import { canvasRuntimePaneId, canvasRuntimeScope } from "./canvas-runtime-scope";
import { agentRecordToNode } from "./canvas-agent-node";
import { CRITIC_DEFAULT_MODEL } from "./critic-prompt";
import {
  DEFAULT_BROWSER_SIZE,
  DEFAULT_CONTEXT_SIZE,
  DEFAULT_CRITIC_SIZE,
  DEFAULT_FRAME_SIZE,
  DEFAULT_HOST_CELL_SIZE,
  DEFAULT_FACTORY_NODE_SIZE,
  DEFAULT_FILE_NODE_SIZE,
  DEFAULT_HUMAN_GATE_SIZE,
  DEFAULT_MUSIC_SIZE,
  DEFAULT_SHAPE_SIZE,
  DEFAULT_NOTE_SIZE,
  DEFAULT_PLAN_SIZE,
  DEFAULT_RUN_NODE_SIZE,
  DEFAULT_SKILL_SIZE,
  DEFAULT_SKILLS_SIZE,
  DEFAULT_TASK_SIZE,
  DEFAULT_TEAM_SIZE,
  DEFAULT_TERMINAL_SIZE,
  type CanvasNodeSize,
  type CanvasPoint,
} from "./canvas-node-placement";

const OFF_CANVAS_LIMIT = 4000;
const NOTE_DRAG_HANDLE = ".canvas-node-header, .canvas-node-glyph";

function sized(node: Omit<Node, "width" | "height" | "style">, { w, h }: CanvasNodeSize): Node {
  return { ...node, width: w, height: h, style: { width: w, height: h } };
}

export function terminalNode(opts: {
  id: string;
  cwd: string;
  terminalNumber: number;
  label?: string;
  position: CanvasPoint;
  activeProjectId: string | null;
  assignedWorktree?: string | null;
  size?: CanvasNodeSize;
  /**
   * The pane id of a cell this machine's Standalone Host already owns.
   *
   * Present means this node does not start anything: it attaches to the tmux session the host runs
   * that cell in. That is the whole of "adoption" — the cell keeps its own life, and the canvas
   * gets a window onto it.
   */
  adoptedPaneId?: string;
  /**
   * The program this terminal runs instead of a shell: a task delegated from the Dock's Tasks
   * (`plans/canvas-dock/` S4b). Session-only like Code's `terminalCommand`: `canvas-serialize`
   * does not write it, because a reopened board relaunching it would ask the agent for the work
   * again, and a chosen `--session-id` is already taken by then.
   */
  launchCommand?: string[];
  /** Session-only like `launchCommand`: the Lotus Claude account it runs on (issues/07). */
  claudeAccount?: string;
  /** The Lotus task this terminal was opened for, so a second one for it makes the task's Frame. */
  spawnTaskKey?: string;
}): Node {
  return sized(
    {
      id: opts.id,
      type: "terminal",
      position: opts.position,
      data: {
        cwd: opts.cwd,
        terminalNumber: opts.terminalNumber,
        ...(opts.label ? { label: opts.label } : {}),
        assignedWorktree: opts.assignedWorktree ?? null,
        ...(opts.adoptedPaneId ? { adoptedPaneId: opts.adoptedPaneId } : {}),
        ...(opts.launchCommand?.length ? { launchCommand: opts.launchCommand } : {}),
        ...(opts.claudeAccount ? { claudeAccount: opts.claudeAccount } : {}),
        ...(opts.spawnTaskKey ? { spawnTaskKey: opts.spawnTaskKey } : {}),
        runtimeScope: canvasRuntimeScope(opts.activeProjectId),
        runtimePaneId: canvasRuntimePaneId(opts.activeProjectId, opts.id),
      },
    },
    opts.size ?? DEFAULT_TERMINAL_SIZE,
  );
}

export function noteNode(
  id: string,
  position: CanvasPoint,
  content = "",
  size = DEFAULT_NOTE_SIZE,
  noteNumber?: number,
  editedAt?: number,
  coverUri?: string,
  editedBy?: string,
): Node {
  return sized(
    {
      id,
      type: "note",
      position,
      draggable: true,
      dragHandle: NOTE_DRAG_HANDLE,
      data: { content, ...(noteNumber ? { noteNumber } : {}), ...(editedAt ? { editedAt } : {}), ...(coverUri ? { coverUri } : {}), ...(editedBy ? { editedBy } : {}) },
    },
    size,
  );
}

export function shapeNode(opts: {
  id: string;
  position: CanvasPoint;
  shape: CanvasShapeKind;
  text?: string;
  angle?: number;
  areaLabel?: string;
  points?: Array<[number, number]>;
  style?: CanvasShapeStyle;
  shapeNumber?: number;
  groupIds?: string[];
  diagramId?: string;
  diagramFrame?: boolean;
  diagramNodeId?: string;
  imageAssetUri?: string;
  imageAlt?: string;
  imageNaturalWidth?: number;
  imageNaturalHeight?: number;
  size?: CanvasNodeSize;
}): Node {
  return sized(
    {
      id: opts.id,
      type: "shape",
      position: opts.position,
      data: {
        shape: opts.shape,
        ...(opts.text !== undefined ? { text: opts.text } : {}),
        ...(typeof opts.angle === "number" && opts.angle !== 0 ? { angle: opts.angle } : {}),
        ...(opts.areaLabel !== undefined ? { areaLabel: opts.areaLabel } : {}),
        ...(opts.points ? { points: opts.points } : {}),
        ...(opts.style ? { style: opts.style } : {}),
        ...(opts.imageAssetUri ? { imageAssetUri: opts.imageAssetUri } : {}),
        ...(opts.imageAlt !== undefined ? { imageAlt: opts.imageAlt } : {}),
        ...(opts.imageNaturalWidth !== undefined ? { imageNaturalWidth: opts.imageNaturalWidth } : {}),
        ...(opts.imageNaturalHeight !== undefined ? { imageNaturalHeight: opts.imageNaturalHeight } : {}),
        ...(opts.shapeNumber ? { shapeNumber: opts.shapeNumber } : {}),
        ...(opts.groupIds && opts.groupIds.length > 0 ? { groupIds: opts.groupIds } : {}),
        ...(opts.diagramId ? { diagramId: opts.diagramId } : {}),
        ...(opts.diagramFrame ? { diagramFrame: true } : {}),
        ...(opts.diagramNodeId ? { diagramNodeId: opts.diagramNodeId } : {}),
      },
    },
    opts.size ?? DEFAULT_SHAPE_SIZE,
  );
}

/**
 * A Frame: a titled region painted behind its members. Pointer-transparent body and the final look
 * arrive with the Frames UI tickets; this is the data-carrying node.
 */
export function frameNode(opts: {
  id: string;
  position: CanvasPoint;
  title: string;
  colorId?: string;
  diagramId?: string;
  taskKey?: string;
  size?: CanvasNodeSize;
}): Node {
  const base = sized(
    {
      id: opts.id,
      type: "frame",
      position: opts.position,
      data: {
        title: opts.title,
        ...(opts.colorId ? { colorId: opts.colorId } : {}),
        ...(opts.diagramId ? { diagramId: opts.diagramId } : {}),
        ...(opts.taskKey ? { taskKey: opts.taskKey } : {}),
      },
    },
    opts.size ?? DEFAULT_FRAME_SIZE,
  );
  // The Frame's empty inside lets clicks and drags through (pan, marquee, the members on top);
  // only its title tab and border take the pointer (FrameNode). React Flow spreads node.style
  // after its own pointer-events, so this wins. Not persisted: load rebuilds through here.
  return { ...base, style: { ...base.style, pointerEvents: "none" } };
}

export function planNode(opts: {
  id: string;
  position: CanvasPoint;
  cwd: string;
  title?: string;
  steps?: CanvasPlanStep[];
  ownerBindings?: Record<string, string>;
  size?: CanvasNodeSize;
}): Node {
  return sized(
    {
      id: opts.id,
      type: "plan",
      position: opts.position,
      data: {
        title: opts.title ?? "Plan",
        steps: opts.steps ?? [],
        cwd: opts.cwd,
        ...(opts.ownerBindings ? { ownerBindings: opts.ownerBindings } : {}),
      },
    },
    opts.size ?? DEFAULT_PLAN_SIZE,
  );
}

export function runNode(opts: {
  id: string;
  position: CanvasPoint;
  memberIds: string[];
  title?: string;
  brief?: string;
  budgetCap?: number;
  open?: boolean;
  size?: CanvasNodeSize;
}): Node {
  const data = {
    title: opts.title ?? "Run", memberIds: [...opts.memberIds], brief: opts.brief ?? "",
    ...(opts.budgetCap !== undefined ? { budgetCap: opts.budgetCap } : {}),
    ...(opts.open ? { open: true } : {}),
  };
  return sized(
    { id: opts.id, type: "run", position: opts.position, data },
    opts.size ?? DEFAULT_RUN_NODE_SIZE,
  );
}

export function skillsNode(opts: { id: string; position: CanvasPoint; parentTerminalId: string; cwd: string }): Node {
  return sized(
    { id: opts.id, type: "skills", position: opts.position, data: { parentTerminalId: opts.parentTerminalId, cwd: opts.cwd } },
    DEFAULT_SKILLS_SIZE,
  );
}

/** The mutable data fields a Canvas Skill preview node carries — shared by create and replace-in-place. */
export function skillPreviewData(skill: CanvasSkillPreview) {
  return {
    skillName: skill.name,
    source: skill.source,
    content: skill.content,
    description: skill.description,
    path: skill.path,
    metadata: skill.metadata,
  };
}

export function skillNode(opts: { id: string; position: CanvasPoint; skill: CanvasSkillPreview }): Node {
  return sized({ id: opts.id, type: "skill", position: opts.position, data: skillPreviewData(opts.skill) }, DEFAULT_SKILL_SIZE);
}

export function taskNode(opts: {
  id: string;
  position: CanvasPoint;
  cwd: string;
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
  size?: CanvasNodeSize;
}): Node {
  return sized(
    {
      id: opts.id,
      type: "task",
      position: opts.position,
      data: {
        title: opts.title ?? "Task",
        description: opts.description ?? "",
        status: opts.status ?? "todo",
        priority: opts.priority ?? "none",
        cwd: opts.cwd,
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
        ...(opts.taskWorkspaceId ? { taskWorkspaceId: opts.taskWorkspaceId } : {}),
        ...(opts.dispatchedAgentIds ? { dispatchedAgentIds: opts.dispatchedAgentIds } : {}),
        ...(opts.intent !== undefined ? { intent: opts.intent } : {}),
        ...(opts.taskClass ? { taskClass: opts.taskClass } : {}),
        ...(opts.when ? { when: opts.when } : {}),
        ...(opts.acceptanceCriteria ? { acceptanceCriteria: opts.acceptanceCriteria } : {}),
      },
    },
    opts.size ?? DEFAULT_TASK_SIZE,
  );
}

export function teamNode(opts: {
  id: string;
  position: CanvasPoint;
  cwd?: string;
  teamId?: string;
  name?: string;
  description?: string;
  goal?: string;
  members?: AgentDefinition[];
  size?: CanvasNodeSize;
}): Node {
  return sized(
    {
      id: opts.id,
      type: "team",
      position: opts.position,
      data: {
        cwd: opts.cwd ?? "",
        ...(opts.teamId ? { teamId: opts.teamId } : {}),
        name: opts.name ?? "Agent Team",
        description: opts.description ?? "Coordinated team run",
        goal: opts.goal ?? "Complete the approved workflow step.",
        members: opts.members ?? [],
      },
    },
    opts.size ?? DEFAULT_TEAM_SIZE,
  );
}

export function contextNode(opts: { id: string; position: CanvasPoint; title?: string; size?: CanvasNodeSize }): Node {
  return sized(
    { id: opts.id, type: "context", position: opts.position, data: { title: opts.title ?? "Context Bus" } },
    opts.size ?? DEFAULT_CONTEXT_SIZE,
  );
}

export function musicNode(opts: { id: string; position: CanvasPoint; activeTrackId?: string; volume?: number; size?: CanvasNodeSize }): Node {
  return sized(
    {
      id: opts.id,
      type: "music",
      position: opts.position,
      // The card is one big interactive surface — drag only from the header/glyph (note pattern).
      dragHandle: NOTE_DRAG_HANDLE,
      data: {
        ...(opts.activeTrackId ? { activeTrackId: opts.activeTrackId } : {}),
        ...(typeof opts.volume === "number" ? { volume: opts.volume } : {}),
      },
    },
    opts.size ?? DEFAULT_MUSIC_SIZE,
  );
}

/**
 * A cell the machine's host runs **without a terminal**, shown as its conversation.
 *
 * The other half of adoption (ticket 12). An adopted `terminalNode` attaches to the tmux session
 * its cell runs in; this one has no session to attach to, so it carries the pane id in order to
 * *ask* — `machine_host_conversation` for the turns, `machine_host_dispatch` to add one.
 *
 * `adoptedPaneId` is spelled the same as on `terminalNode` on purpose: ⌘K refuses to offer a cell
 * that is already on the board by looking for that key on any node, so the two adoption shapes
 * share one guard instead of each needing to remember the other exists.
 */
export function hostCellNode(opts: {
  id: string;
  position: CanvasPoint;
  adoptedPaneId: string;
  cwd: string;
  label: string;
  provider: string;
  size?: CanvasNodeSize;
}): Node {
  return sized(
    {
      id: opts.id,
      type: "host-cell",
      position: opts.position,
      // The body is a scrollable transcript with a composer in it — dragging from anywhere would
      // fight text selection, so the header/glyph is the handle (the Note/Music pattern).
      dragHandle: NOTE_DRAG_HANDLE,
      data: {
        adoptedPaneId: opts.adoptedPaneId,
        cwd: opts.cwd,
        label: opts.label,
        provider: opts.provider,
      },
    },
    opts.size ?? DEFAULT_HOST_CELL_SIZE,
  );
}

/** One issue's Factory Run (#146). The node holds the issue; the run is read live. */
export function factoryNode(opts: { id: string; position: CanvasPoint; repo: string; issue: number | string; title: string; size?: CanvasNodeSize }): Node {
  return sized(
    { id: opts.id, type: "factory", position: opts.position, data: { repo: opts.repo, issue: opts.issue, title: opts.title } },
    opts.size ?? DEFAULT_FACTORY_NODE_SIZE,
  );
}

/**
 * One project file, read-only and live (plans/canvas-code, S3). The header is the drag handle: the
 * body scrolls its own code, so dragging from anywhere would fight reading (Note/Music pattern).
 */
export function fileNode(opts: { id: string; position: CanvasPoint; path: string; topLine?: number; size?: CanvasNodeSize }): Node {
  return sized(
    {
      id: opts.id,
      type: "file",
      position: opts.position,
      dragHandle: NOTE_DRAG_HANDLE,
      data: { path: opts.path, ...(opts.topLine && opts.topLine > 0 ? { viewport: { topLine: opts.topLine } } : {}) },
    },
    opts.size ?? DEFAULT_FILE_NODE_SIZE,
  );
}

export function criticNode(opts: { id: string; position: CanvasPoint; cwd: string; title?: string; model?: string; size?: CanvasNodeSize }): Node {
  return sized(
    {
      id: opts.id,
      type: "critic",
      position: opts.position,
      data: { title: opts.title ?? "Critic", cwd: opts.cwd, model: opts.model ?? CRITIC_DEFAULT_MODEL },
    },
    opts.size ?? DEFAULT_CRITIC_SIZE,
  );
}

export function humanGateNode(opts: {
  id: string;
  position: CanvasPoint;
  title?: string;
  instructions?: string;
  gateKind?: "clarification" | "approval";
  status?: "idle" | "waiting" | "approved" | "rejected";
  size?: CanvasNodeSize;
}): Node {
  return sized(
    {
      id: opts.id,
      type: "human-gate",
      position: opts.position,
      data: {
        title: opts.title ?? "Human Approval",
        instructions: opts.instructions ?? "Review the upstream output and approve or reject this gate.",
        gateKind: opts.gateKind ?? "approval",
        status: opts.status ?? "idle",
      },
    },
    opts.size ?? DEFAULT_HUMAN_GATE_SIZE,
  );
}

function isBlankBrowserUrl(url: string): boolean {
  const value = url.trim().toLowerCase();
  return value === "" || value === "about:blank";
}

export function browserNode(opts: {
  id: string;
  position: CanvasPoint;
  /** null for standalone browsers spawned without a parent terminal. */
  parentTerminalId: string | null;
  url: string;
  browserNumber: number;
  label?: string;
  state?: CanvasBrowserState;
  viewportMode?: CanvasBrowserViewportMode;
  viewportOrientation?: CanvasBrowserOrientation;
  viewportWidth?: number;
  viewportHeight?: number;
  viewportScaleMode?: CanvasBrowserScaleMode;
  viewportZoom?: number | null;
  size?: CanvasNodeSize;
}): Node {
  return sized(
    {
      id: opts.id,
      type: "browser",
      position: opts.position,
      data: {
        parentTerminalId: opts.parentTerminalId,
        url: opts.url,
        state: opts.state ?? (isBlankBrowserUrl(opts.url) ? "disconnected" : "loading"),
        browserNumber: opts.browserNumber,
        ...(opts.label ? { label: opts.label } : {}),
        ...(opts.viewportMode ? { viewportMode: opts.viewportMode } : {}),
        ...(opts.viewportOrientation ? { viewportOrientation: opts.viewportOrientation } : {}),
        ...(typeof opts.viewportWidth === "number" ? { viewportWidth: opts.viewportWidth } : {}),
        ...(typeof opts.viewportHeight === "number" ? { viewportHeight: opts.viewportHeight } : {}),
        ...(opts.viewportScaleMode ? { viewportScaleMode: opts.viewportScaleMode } : {}),
        ...(typeof opts.viewportZoom === "number" ? { viewportZoom: opts.viewportZoom } : {}),
      },
    },
    opts.size ?? DEFAULT_BROWSER_SIZE,
  );
}

function clampPosition(position: CanvasPoint): CanvasPoint {
  return {
    x: Math.abs(position.x) > OFF_CANVAS_LIMIT ? 80 : position.x,
    y: Math.abs(position.y) > OFF_CANVAS_LIMIT ? 80 : position.y,
  };
}

/** Hydrate a persisted record into a live ReactFlow node, preserving its stored size and clamping wild positions. */
export function recordToNode(record: CanvasNodeRecord, rootDir: string, activeProjectId: string | null): Node {
  const node = recordToNodeBase(record, rootDir, activeProjectId);
  // One place carries the Frame reference and spawn-task stamp for every kind, so a new kind cannot forget it.
  if (record.type === "frame") return node;
  if (!record.frameId && !record.spawnTaskKey) return node;
  return {
    ...node,
    data: {
      ...node.data,
      ...(record.frameId ? { frameId: record.frameId } : {}),
      ...(record.spawnTaskKey ? { spawnTaskKey: record.spawnTaskKey } : {}),
      ...(record.spawnTaskKey && record.spawnTaskTitle ? { spawnTaskTitle: record.spawnTaskTitle } : {}),
    },
  };
}

function recordToNodeBase(record: CanvasNodeRecord, rootDir: string, activeProjectId: string | null): Node {
  const position = clampPosition(record.position);
  if (record.type === "terminal") {
    return terminalNode({
      id: record.id,
      cwd: record.cwd || rootDir || "",
      terminalNumber: record.terminalNumber ?? 1,
      label: record.label,
      assignedWorktree: record.assignedWorktree ?? null,
      position,
      activeProjectId,
      size: record.size,
      // Without this an adopted terminal came back from a reload as an ordinary one: same label,
      // same cwd, but attaching to nothing and opening a fresh shell on the far machine beside the
      // cell it was supposed to be showing. The pane id was being written by adoption and dropped
      // by every one of the three hops back (serialize, codec, here).
      ...(record.adoptedPaneId ? { adoptedPaneId: record.adoptedPaneId } : {}),
    });
  }
  if (record.type === "frame") {
    return frameNode({ id: record.id, position, title: record.title, colorId: record.colorId, diagramId: record.diagramId, taskKey: record.taskKey, size: record.size });
  }
  if (record.type === "agent") {
    return agentRecordToNode(record, rootDir, position);
  }
  if (record.type === "plan") {
    return planNode({ id: record.id, position, cwd: rootDir, title: record.title, steps: record.steps, ownerBindings: record.ownerBindings, size: record.size });
  }
  if (record.type === "run") {
    return runNode({ id: record.id, position, title: record.title, memberIds: record.memberIds, brief: record.brief, budgetCap: record.budgetCap, open: record.open, size: record.size });
  }
  if (record.type === "task") {
    return taskNode({
      id: record.id,
      position,
      cwd: rootDir,
      title: record.title,
      description: record.description,
      status: record.status,
      priority: record.priority,
      taskId: record.taskId,
      taskWorkspaceId: record.taskWorkspaceId,
      dispatchedAgentIds: record.dispatchedAgentIds,
      intent: record.intent,
      taskClass: record.taskClass,
      when: record.when,
      acceptanceCriteria: record.acceptanceCriteria,
      size: record.size,
    });
  }
  if (record.type === "team") {
    return teamNode({
      id: record.id,
      position,
      cwd: record.cwd || rootDir || "",
      teamId: record.teamId,
      name: record.name,
      description: record.description,
      goal: record.goal,
      members: record.members,
      size: record.size,
    });
  }
  if (record.type === "context") {
    return contextNode({ id: record.id, position, title: record.title, size: record.size });
  }
  if (record.type === "music") {
    return musicNode({ id: record.id, position, activeTrackId: record.activeTrackId, volume: record.volume, size: record.size });
  }
  if (record.type === "host-cell") {
    return hostCellNode({
      id: record.id,
      position,
      adoptedPaneId: record.adoptedPaneId,
      cwd: record.cwd,
      label: record.label,
      provider: record.provider,
      size: record.size,
    });
  }
  if (record.type === "factory") {
    return factoryNode({ id: record.id, position, repo: record.repo, issue: record.issue, title: record.title, size: record.size });
  }
  if (record.type === "file") {
    return fileNode({ id: record.id, position, path: record.path, topLine: record.viewport?.topLine, size: record.size });
  }
  if (record.type === "critic") {
    return criticNode({ id: record.id, position, cwd: rootDir, title: record.title, model: record.model, size: record.size });
  }
  if (record.type === "human-gate") {
    return humanGateNode({
      id: record.id,
      position,
      title: record.title,
      instructions: record.instructions,
      gateKind: record.gateKind,
      status: record.status,
      size: record.size,
    });
  }
  if (record.type === "browser") {
    return browserNode({
      id: record.id,
      position,
      parentTerminalId: record.parentTerminalId,
      url: record.url,
      browserNumber: record.browserNumber,
      label: record.label,
      state: "disconnected",
      viewportMode: record.viewportMode,
      viewportOrientation: record.viewportOrientation,
      viewportWidth: record.viewportWidth,
      viewportHeight: record.viewportHeight,
      viewportScaleMode: record.viewportScaleMode,
      viewportZoom: record.viewportZoom,
      size: record.size,
    });
  }
  if (record.type === "shape") {
    return shapeNode({
      id: record.id,
      position,
      shape: record.shape,
      text: record.text,
      angle: record.angle,
      areaLabel: record.areaLabel,
      points: record.points,
      style: record.style,
      shapeNumber: record.shapeNumber,
      groupIds: record.groupIds,
      diagramId: record.diagramId,
      diagramFrame: record.diagramFrame,
      diagramNodeId: record.diagramNodeId,
      imageAssetUri: record.imageAssetUri,
      imageAlt: record.imageAlt,
      imageNaturalWidth: record.imageNaturalWidth,
      imageNaturalHeight: record.imageNaturalHeight,
      size: record.size,
    });
  }
  return noteNode(record.id, position, record.content, record.size, record.noteNumber, record.editedAt, record.coverUri, record.editedBy);
}
