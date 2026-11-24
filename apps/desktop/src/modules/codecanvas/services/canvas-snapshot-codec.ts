import { normalizeReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";
import type {
  AcceptanceCriterion,
  AgentDefinition,
  CanvasEdgeRecord,
  CanvasNodeRecord,
  CanvasSnapshot,
  CanvasTaskPriority,
  CanvasTaskStatus,
  TaskClass,
  TaskWhen,
} from "../types/canvas";
import { normalizeTerminalLabel } from "./terminal/terminal-node-identity";
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
  DEFAULT_NOTE_SIZE,
  DEFAULT_PLAN_SIZE,
  DEFAULT_RUN_NODE_SIZE,
  DEFAULT_SHAPE_SIZE,
  DEFAULT_TASK_SIZE,
  DEFAULT_TEAM_SIZE,
  DEFAULT_TERMINAL_SIZE,
  type CanvasNodeSize,
} from "./canvas-node-placement";
import { migrateLegacyGroupsToFrames } from "./canvas-frame-migration";
import { normalizeShapeFields } from "./canvas-shape";
import { normalizeBudgetCap } from "./run-node";

export type CanvasSnapshotRepairKind = "dropped-node" | "dropped-edge" | "normalized-node";

export interface CanvasSnapshotRepair {
  kind: CanvasSnapshotRepairKind;
  id: string;
  reason: string;
}

export type CanvasSnapshotDecodeResult =
  | { ok: true; snapshot: CanvasSnapshot; repairs: CanvasSnapshotRepair[] }
  | { ok: false; error: string; repairs: CanvasSnapshotRepair[] };

type MigrationResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/**
 * The node types a saved board may contain.
 *
 * Exported so one test can hold the other half of the bargain: every type accepted here must
 * have a component in `CANVAS_NODE_TYPES`, or a board reopens with a ReactFlow default box where
 * a node used to be — valid in the file, meaningless on screen.
 */
export const CANVAS_PERSISTED_NODE_TYPES = new Set(["terminal", "note", "agent", "team", "plan", "run", "task", "context", "critic", "human-gate", "browser", "shape", "music", "host-cell", "factory", "file", "frame"]);
const TASK_STATUSES = new Set<CanvasTaskStatus>(["todo", "in-progress", "blocked", "in-review", "complete", "cancelled"]);
const TASK_PRIORITIES = new Set<CanvasTaskPriority>(["none", "low", "medium", "high"]);
const TASK_CLASSES = new Set<TaskClass>(["quick", "needs-research", "deep-focus", "benchmark"]);
const TASK_WHENS = new Set<TaskWhen>(["urgent", "this-week", "this-month", "whenever"]);
const AGENT_RUNNERS = new Set(["claude", "ccs", "csp", "codex", "custom"]);

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

export function migrateCanvasSnapshot(data: Record<string, unknown>): MigrationResult {
  if (data.schemaVersion === 1) return { ok: true, data };
  return { ok: false, error: `Canvas snapshot schema version ${String(data.schemaVersion)} is not supported` };
}

function positionOf(value: unknown): { x: number; y: number } {
  const raw = objectOf(value);
  return { x: numberOf(raw?.x, 0), y: numberOf(raw?.y, 0) };
}

function sizeOf(value: unknown, fallback: CanvasNodeSize): CanvasNodeSize {
  const raw = objectOf(value);
  const w = numberOf(raw?.w, fallback.w);
  const h = numberOf(raw?.h, fallback.h);
  return { w: w > 0 ? w : fallback.w, h: h > 0 ? h : fallback.h };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function agentDefinitionOf(value: unknown): AgentDefinition {
  const raw = objectOf(value) ?? {};
  return {
    id: stringOf(raw.id),
    name: stringOf(raw.name, "Agent"),
    ...(typeof raw.role === "string" ? { role: raw.role } : {}),
    model: stringOf(raw.model),
    prompt: stringOf(raw.prompt),
    appliedSkills: stringsOf(raw.appliedSkills),
    ...(typeof raw.effort === "string" ? { effort: normalizeReasoningLevel(raw.effort) } : {}),
    ...(typeof raw.permissionMode === "string" ? { permissionMode: raw.permissionMode } : {}),
    updatedAt: numberOf(raw.updatedAt, 0),
  };
}

function criteriaOf(value: unknown): AcceptanceCriterion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item, index) => {
    const raw = objectOf(item) ?? {};
    return { id: stringOf(raw.id, `criterion-${index + 1}`), text: stringOf(raw.text), done: raw.done === true };
  });
}

function budgetCapOf(value: unknown): { budgetCap?: number } {
  const budgetCap = normalizeBudgetCap(value);
  return budgetCap !== undefined ? { budgetCap } : {};
}

/** Kind-specific fields; the Frame reference is added for every kind by `normalizeNode`. */
function normalizeNodeFields(raw: Record<string, unknown>, repairs: CanvasSnapshotRepair[]): CanvasNodeRecord | null {
  const type = stringOf(raw.type);
  const id = stringOf(raw.id);
  if (!id || !CANVAS_PERSISTED_NODE_TYPES.has(type)) {
    repairs.push({ kind: "dropped-node", id: id || "(missing id)", reason: `Unsupported node type: ${type || "missing"}` });
    return null;
  }
  const position = positionOf(raw.position);
  const changedPosition = objectOf(raw.position)?.x !== position.x || objectOf(raw.position)?.y !== position.y;
  const markNormalized = (reason: string) => repairs.push({ kind: "normalized-node", id, reason });
  if (changedPosition) markNormalized("Invalid position was normalized");

  if (type === "terminal") {
    const label = normalizeTerminalLabel(raw.label);
    return {
      type, id, position, size: sizeOf(raw.size, DEFAULT_TERMINAL_SIZE), cwd: stringOf(raw.cwd),
      terminalNumber: numberOf(raw.terminalNumber, 1), ...(label ? { label } : {}), assignedWorktree: nullableString(raw.assignedWorktree),
      ...(hasOwn(raw, "assignedWorktreePath") ? { assignedWorktreePath: nullableString(raw.assignedWorktreePath) } : {}),
      ...(hasOwn(raw, "baseBranch") ? { baseBranch: nullableString(raw.baseBranch) } : {}),
      // See `canvas-serialize.ts`: dropping this here turned an adopted terminal back into an
      // ordinary one on reload, silently and with the same label.
      ...(typeof raw.adoptedPaneId === "string" && raw.adoptedPaneId ? { adoptedPaneId: raw.adoptedPaneId } : {}),
    };
  }
  if (type === "frame") return {
    type, id, position, size: sizeOf(raw.size, DEFAULT_FRAME_SIZE), title: stringOf(raw.title),
    ...(typeof raw.colorId === "string" && raw.colorId ? { colorId: raw.colorId } : {}),
    ...(typeof raw.diagramId === "string" && raw.diagramId ? { diagramId: raw.diagramId } : {}),
    ...(typeof raw.taskKey === "string" && raw.taskKey ? { taskKey: raw.taskKey } : {}),
  };
  if (type === "host-cell") {
    // A headless cell is nothing without its pane id — that is the only handle on a conversation
    // the host, not the canvas, owns. A record that lost it would hydrate into a node that can
    // never ask anything, so it is dropped rather than drawn as a box that does nothing.
    const adoptedPaneId = stringOf(raw.adoptedPaneId);
    if (!adoptedPaneId) {
      repairs.push({ kind: "dropped-node", id, reason: "Host cell node missing its pane id" });
      return null;
    }
    return {
      type, id, position, size: sizeOf(raw.size, DEFAULT_HOST_CELL_SIZE),
      adoptedPaneId, cwd: stringOf(raw.cwd), label: stringOf(raw.label), provider: stringOf(raw.provider),
    };
  }
  if (type === "factory") {
    // The repo and issue are how the node finds its run; without them it can show nothing.
    const repo = stringOf(raw.repo);
    const issue =
      typeof raw.issue === "number" && Number.isInteger(raw.issue) && raw.issue > 0
        ? raw.issue
        : typeof raw.issue === "string" && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(raw.issue)
          ? raw.issue
          : 0;
    if (!repo || !issue) {
      repairs.push({ kind: "dropped-node", id, reason: "Factory node missing its repo or issue" });
      return null;
    }
    return { type, id, position, size: sizeOf(raw.size, DEFAULT_FACTORY_NODE_SIZE), repo, issue, title: stringOf(raw.title) };
  }
  if (type === "file") {
    // The path is the node's only content; without it there is nothing to read. Dropped, never
    // drawn as an empty box and never decoded as the browser fallback below.
    const path = stringOf(raw.path).trim();
    if (!path) {
      repairs.push({ kind: "dropped-node", id, reason: "File node missing its path" });
      return null;
    }
    const viewport = objectOf(raw.viewport);
    const topLine = viewport?.topLine;
    const validTopLine = typeof topLine === "number" && Number.isFinite(topLine) && topLine >= 0 ? Math.floor(topLine) : null;
    if (viewport && validTopLine === null) markNormalized("Invalid file viewport was dropped");
    return {
      type, id, position, size: sizeOf(raw.size, DEFAULT_FILE_NODE_SIZE), path,
      ...(validTopLine !== null && validTopLine > 0 ? { viewport: { topLine: validTopLine } } : {}),
    };
  }
  if (type === "note") return {
    type, id, position, size: sizeOf(raw.size, DEFAULT_NOTE_SIZE), content: stringOf(raw.content),
    ...(raw.noteNumber ? { noteNumber: numberOf(raw.noteNumber, 1) } : {}),
    ...(typeof raw.editedAt === "number" && Number.isFinite(raw.editedAt) ? { editedAt: raw.editedAt } : {}),
    ...(typeof raw.coverUri === "string" && raw.coverUri ? { coverUri: raw.coverUri } : {}),
    ...(typeof raw.editedBy === "string" && raw.editedBy ? { editedBy: raw.editedBy } : {}),
  };
  if (type === "agent") return {
    type, id, position, size: sizeOf(raw.size, DEFAULT_TERMINAL_SIZE), cwd: stringOf(raw.cwd), agentNumber: numberOf(raw.agentNumber, 1),
    agentDefId: stringOf(raw.agentDefId), name: stringOf(raw.name, "Agent"), model: stringOf(raw.model), prompt: stringOf(raw.prompt),
    ...(raw.executionMode === "live" ? { executionMode: "live" as const } : {}),
    ...(typeof raw.runner === "string" && AGENT_RUNNERS.has(raw.runner) ? { runner: raw.runner as import("../types/canvas").CanvasAgentNodeRecord["runner"] } : {}),
    ...(typeof raw.runnerCommand === "string" && raw.runnerCommand ? { runnerCommand: raw.runnerCommand } : {}),
    ...(typeof raw.color === "string" && raw.color ? { color: raw.color } : {}),
    ...(Array.isArray(raw.appliedSkills) ? { appliedSkills: stringsOf(raw.appliedSkills) } : {}),
    ...(typeof raw.effort === "string" ? { effort: normalizeReasoningLevel(raw.effort) } : {}), ...(typeof raw.permissionMode === "string" ? { permissionMode: raw.permissionMode } : {}),
    assignedWorktree: nullableString(raw.assignedWorktree), assignedWorktreePath: nullableString(raw.assignedWorktreePath), baseBranch: nullableString(raw.baseBranch),
    ...(typeof raw.resumeSessionId === "string" && raw.resumeSessionId ? { resumeSessionId: raw.resumeSessionId } : {}),
    ...(typeof raw.account === "string" && raw.account ? { account: raw.account } : {}),
  };
  if (type === "team") return { type, id, position, size: sizeOf(raw.size, DEFAULT_TEAM_SIZE), cwd: stringOf(raw.cwd), ...(typeof raw.teamId === "string" ? { teamId: raw.teamId } : {}), name: stringOf(raw.name, "Agent Team"), description: stringOf(raw.description, "Coordinated team run"), goal: stringOf(raw.goal, "Complete the approved workflow step."), members: Array.isArray(raw.members) ? raw.members.map(agentDefinitionOf) : [] };
  if (type === "plan") return { type, id, position, size: sizeOf(raw.size, DEFAULT_PLAN_SIZE), title: stringOf(raw.title, "Plan"), steps: Array.isArray(raw.steps) ? raw.steps.map((s) => ({ title: stringOf(objectOf(s)?.title), ...(typeof objectOf(s)?.owner === "string" ? { owner: objectOf(s)?.owner as string } : {}), ...(typeof objectOf(s)?.done === "boolean" ? { done: objectOf(s)?.done as boolean } : {}) })) : [], ...(objectOf(raw.ownerBindings) ? { ownerBindings: raw.ownerBindings as Record<string, string> } : {}) };
  if (type === "run") return { type, id, position, size: sizeOf(raw.size, DEFAULT_RUN_NODE_SIZE), title: stringOf(raw.title, "Run"), memberIds: Array.isArray(raw.memberIds) ? stringsOf(raw.memberIds) : [], ...(typeof raw.brief === "string" && raw.brief.trim() ? { brief: raw.brief } : {}), ...budgetCapOf(raw.budgetCap), ...(raw.open === true ? { open: true } : {}) };
  if (type === "task") return { type, id, position, size: sizeOf(raw.size, DEFAULT_TASK_SIZE), title: stringOf(raw.title, "Task"), description: stringOf(raw.description), status: TASK_STATUSES.has(raw.status as CanvasTaskStatus) ? raw.status as CanvasTaskStatus : "todo", priority: TASK_PRIORITIES.has(raw.priority as CanvasTaskPriority) ? raw.priority as CanvasTaskPriority : "none", ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}), ...(typeof raw.taskWorkspaceId === "string" ? { taskWorkspaceId: raw.taskWorkspaceId } : {}), ...(Array.isArray(raw.dispatchedAgentIds) ? { dispatchedAgentIds: stringsOf(raw.dispatchedAgentIds) } : {}), ...(typeof raw.intent === "string" ? { intent: raw.intent } : {}), ...(TASK_CLASSES.has(raw.taskClass as TaskClass) ? { taskClass: raw.taskClass as TaskClass } : {}), ...(TASK_WHENS.has(raw.when as TaskWhen) ? { when: raw.when as TaskWhen } : {}), ...(criteriaOf(raw.acceptanceCriteria) ? { acceptanceCriteria: criteriaOf(raw.acceptanceCriteria) } : {}) };
  if (type === "context") return { type, id, position, size: sizeOf(raw.size, DEFAULT_CONTEXT_SIZE), title: stringOf(raw.title, "Context Bus") };
  if (type === "music") return {
    type, id, position, size: sizeOf(raw.size, DEFAULT_MUSIC_SIZE),
    ...(typeof raw.activeTrackId === "string" && raw.activeTrackId ? { activeTrackId: raw.activeTrackId } : {}),
    ...(typeof raw.volume === "number" && Number.isFinite(raw.volume) ? { volume: Math.max(0, Math.min(100, raw.volume)) } : {}),
  };
  if (type === "critic") return { type, id, position, size: sizeOf(raw.size, DEFAULT_CRITIC_SIZE), title: stringOf(raw.title, "Critic"), ...(typeof raw.model === "string" ? { model: raw.model } : {}) };
  if (type === "human-gate") return { type, id, position, size: sizeOf(raw.size, DEFAULT_HUMAN_GATE_SIZE), title: stringOf(raw.title, "Human Approval"), instructions: stringOf(raw.instructions, "Review the upstream output and approve or reject this gate."), gateKind: raw.gateKind === "clarification" ? "clarification" : "approval", status: ["idle", "waiting", "approved", "rejected"].includes(String(raw.status)) ? raw.status as never : "idle" };
  if (type === "shape") {
    const fields = normalizeShapeFields(raw);
    // An image shape with no asset URI can't render anything (bytes live in the note-asset store,
    // keyed by that URI) — drop it rather than keep an empty box.
    if (fields.shape === "image" && !fields.imageAssetUri) {
      repairs.push({ kind: "dropped-node", id: id || "(missing id)", reason: "Image shape missing asset URI" });
      return null;
    }
    return {
      type, id, position, size: sizeOf(raw.size, DEFAULT_SHAPE_SIZE),
      shape: fields.shape,
      ...(fields.text !== undefined ? { text: fields.text } : {}),
      ...(fields.areaLabel !== undefined ? { areaLabel: fields.areaLabel } : {}),
      ...(fields.points ? { points: fields.points } : {}),
      ...(fields.style ? { style: fields.style } : {}),
      ...(fields.imageAssetUri ? { imageAssetUri: fields.imageAssetUri } : {}),
      ...(fields.imageAlt !== undefined ? { imageAlt: fields.imageAlt } : {}),
      ...(fields.imageNaturalWidth !== undefined ? { imageNaturalWidth: fields.imageNaturalWidth } : {}),
      ...(fields.imageNaturalHeight !== undefined ? { imageNaturalHeight: fields.imageNaturalHeight } : {}),
      ...(hasOwn(raw, "shapeNumber") ? { shapeNumber: numberOf(raw.shapeNumber, 1) } : {}),
      // Legacy group ids: read so the load-time migration can turn them into a Frame, then stripped.
      ...(Array.isArray(raw.groupIds) && raw.groupIds.length > 0 ? { groupIds: stringsOf(raw.groupIds) } : {}),
      ...(typeof raw.angle === "number" && Number.isFinite(raw.angle) && raw.angle !== 0 ? { angle: raw.angle } : {}),
      ...(typeof raw.diagramId === "string" && raw.diagramId ? { diagramId: raw.diagramId } : {}),
      ...(raw.diagramFrame === true ? { diagramFrame: true } : {}),
      ...(typeof raw.diagramNodeId === "string" && raw.diagramNodeId ? { diagramNodeId: raw.diagramNodeId } : {}),
    };
  }
  return {
    type: "browser",
    id,
    position,
    size: sizeOf(raw.size, DEFAULT_BROWSER_SIZE),
    parentTerminalId: nullableString(raw.parentTerminalId),
    url: stringOf(raw.url),
    state: "disconnected",
    browserNumber: numberOf(raw.browserNumber, 1),
    ...(typeof raw.label === "string" && raw.label.trim() ? { label: raw.label.trim() } : {}),
  };
}

function normalizeNode(raw: Record<string, unknown>, repairs: CanvasSnapshotRepair[]): CanvasNodeRecord | null {
  const record = normalizeNodeFields(raw, repairs);
  if (!record || record.type === "frame") return record;
  const withFrame = typeof raw.frameId === "string" && raw.frameId ? { ...record, frameId: raw.frameId } : record;
  return typeof raw.spawnTaskKey === "string" && raw.spawnTaskKey
    ? {
        ...withFrame,
        spawnTaskKey: raw.spawnTaskKey,
        ...(typeof raw.spawnTaskTitle === "string" && raw.spawnTaskTitle ? { spawnTaskTitle: raw.spawnTaskTitle } : {}),
      }
    : withFrame;
}

/** A Frame reference is only meaningful when it names a Frame node in the same snapshot. */
function dropDanglingFrameRefs(nodes: CanvasNodeRecord[], repairs: CanvasSnapshotRepair[]): CanvasNodeRecord[] {
  const frameIds = new Set(nodes.filter((n) => n.type === "frame").map((n) => n.id));
  return nodes.map((node) => {
    if (node.type === "frame" || !node.frameId || frameIds.has(node.frameId)) return node;
    repairs.push({ kind: "normalized-node", id: node.id, reason: `Frame reference ${node.frameId} not found` });
    const { frameId: _dropped, ...rest } = node;
    return rest as CanvasNodeRecord;
  });
}

function edgeOf(raw: unknown, validNodeIds: Set<string>, repairs: CanvasSnapshotRepair[]): CanvasEdgeRecord | null {
  const edge = objectOf(raw);
  const id = stringOf(edge?.id);
  const source = stringOf(edge?.source);
  const target = stringOf(edge?.target);
  if (!id || !source || !target || !validNodeIds.has(source) || !validNodeIds.has(target)) {
    repairs.push({ kind: "dropped-edge", id: id || "(missing id)", reason: "Invalid edge endpoint" });
    return null;
  }
  return { id, source, target, ...(typeof edge?.kind === "string" ? { kind: edge.kind } : {}), ...(typeof edge?.label === "string" ? { label: edge.label } : {}), ...(typeof edge?.sourceHandle === "string" ? { sourceHandle: edge.sourceHandle } : {}), ...(typeof edge?.targetHandle === "string" ? { targetHandle: edge.targetHandle } : {}) };
}

export function decodeCanvasSnapshot(raw: unknown): CanvasSnapshotDecodeResult {
  const repairs: CanvasSnapshotRepair[] = [];
  const data = objectOf(raw);
  if (!data) return { ok: false, error: "Canvas snapshot must be an object", repairs };
  const migrated = migrateCanvasSnapshot(data);
  if (!migrated.ok) return { ok: false, error: migrated.error, repairs };

  const decoded = (Array.isArray(migrated.data.nodes) ? migrated.data.nodes : [])
    .map((node) => objectOf(node))
    .map((node) => node ? normalizeNode(node, repairs) : null)
    .filter((node): node is CanvasNodeRecord => node !== null);
  const nodes = dropDanglingFrameRefs(migrateLegacyGroupsToFrames(decoded), repairs);
  const validNodeIds = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(migrated.data.edges) ? migrated.data.edges : [])
    .map((edge) => edgeOf(edge, validNodeIds, repairs))
    .filter((edge): edge is CanvasEdgeRecord => edge !== null);

  return { ok: true, snapshot: {
    schemaVersion: 1,
    id: stringOf(migrated.data.id, "canvas"),
    rootDir: stringOf(migrated.data.rootDir),
    nodes,
    edges,
    ...(hasOwn(migrated.data, "terminalCounter") ? { terminalCounter: numberOf(migrated.data.terminalCounter, 0) } : {}),
    ...(hasOwn(migrated.data, "agentCounter") ? { agentCounter: numberOf(migrated.data.agentCounter, 0) } : {}),
    ...(hasOwn(migrated.data, "noteCounter") ? { noteCounter: numberOf(migrated.data.noteCounter, 0) } : {}),
    ...(hasOwn(migrated.data, "browserCounter") ? { browserCounter: numberOf(migrated.data.browserCounter, 0) } : {}),
    ...(hasOwn(migrated.data, "shapeCounter") ? { shapeCounter: numberOf(migrated.data.shapeCounter, 0) } : {}),
  }, repairs };
}
