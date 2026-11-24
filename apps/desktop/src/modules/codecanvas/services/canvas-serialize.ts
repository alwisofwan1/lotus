import { normalizeReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";
import type { Node, Edge } from "@xyflow/react";
import { normalizeTerminalLabel } from "./terminal/terminal-node-identity";
import { normalizeBudgetCap } from "./run-node";
import type { AgentDefinition, CanvasSnapshot, CanvasNodeRecord, CanvasPlanStep, CanvasShapeKind, CanvasShapeStyle, CanvasTaskPriority, CanvasTaskStatus, TaskClass, TaskWhen, AcceptanceCriterion } from "../types/canvas";

interface ToCanvasSnapshotParams {
  id: string;
  rootDir: string;
  nodes: Node[];
  edges: Edge[];
  noteContent: Map<string, string>;
  terminalCounter?: number;
  agentCounter?: number;
  noteCounter?: number;
  browserCounter?: number;
  shapeCounter?: number;
}

function numberOrZero(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function serializablePosition(position: Node["position"]): { x: number; y: number } {
  return { x: numberOrZero(position.x), y: numberOrZero(position.y) };
}

function serializableSize(node: Node): { w: number; h: number } {
  return {
    w: numberOrZero(node.measured?.width ?? node.width ?? node.style?.width),
    h: numberOrZero(node.measured?.height ?? node.height ?? node.style?.height),
  };
}

/**
 * Serializes ReactFlow nodes/edges into a persistable Canvas Snapshot.
 * Canvas Skill Nodes are session-only: they and any edge touching them are excluded.
 */
export function toCanvasSnapshot({ id, rootDir, nodes, edges, noteContent, terminalCounter, agentCounter, noteCounter, browserCounter, shapeCounter }: ToCanvasSnapshotParams): CanvasSnapshot {
  // Canvas Skills Nodes and Canvas Skill Nodes are session-only — exclude them and their wires.
  const ephemeralIds = new Set(nodes.filter((n) => n.type === "skill" || n.type === "skills").map((n) => n.id));

  const live = nodes.filter((n) => n.type !== "skill" && n.type !== "skills");
  const records: CanvasNodeRecord[] = live
    .map((n): CanvasNodeRecord => {
      // measured wins (post-resize); fall back to the top-level width ReactFlow v12 uses.
      const size = serializableSize(n);
      const position = serializablePosition(n.position);
      if (n.type === "terminal") {
        const d = n.data as { label?: string; cwd?: string; terminalNumber?: number; assignedWorktree?: string | null; assignedWorktreePath?: string | null; baseBranch?: string | null; adoptedPaneId?: string };
        const label = normalizeTerminalLabel(d.label);
        return {
          type: "terminal" as const,
          id: n.id, position, size,
          cwd: d.cwd ?? rootDir,
          terminalNumber: d.terminalNumber ?? 1,
          ...(label ? { label } : {}),
          assignedWorktree: d.assignedWorktree ?? null,
          assignedWorktreePath: d.assignedWorktreePath ?? null,
          baseBranch: d.baseBranch ?? null,
          // Adoption is the whole difference between this node and an ordinary terminal, and it
          // was being written nowhere: the pane id never left memory, so a reload turned an
          // adopted cell into a plain shell on the same machine (ticket 11, found writing 12).
          ...(typeof d.adoptedPaneId === "string" && d.adoptedPaneId ? { adoptedPaneId: d.adoptedPaneId } : {}),
        };
      }
      if (n.type === "agent") {
        const d = n.data as { agentDefId?: string; name?: string; model?: string; prompt?: string; cwd?: string; agentNumber?: number; executionMode?: "headless" | "live"; runner?: import("@/lib/agent-runtime").AgentRunnerType; runnerCommand?: string; color?: string; appliedSkills?: string[]; effort?: string; permissionMode?: string; assignedWorktree?: string | null; assignedWorktreePath?: string | null; baseBranch?: string | null; resumeSessionId?: string | null; account?: string | null };
        return {
          type: "agent" as const,
          id: n.id, position, size,
          cwd: d.cwd ?? rootDir,
          agentNumber: d.agentNumber ?? 1,
          agentDefId: d.agentDefId ?? "",
          name: d.name ?? "Agent",
          model: d.model ?? "",
          prompt: d.prompt ?? "",
          // Persist only "live"; headless is the load-default, so omitting it keeps old boards stable (ADR-0022).
          ...(d.executionMode === "live" ? { executionMode: "live" as const } : {}),
          ...(d.runner ? { runner: d.runner } : {}),
          ...(d.runnerCommand ? { runnerCommand: d.runnerCommand } : {}),
          ...(d.color ? { color: d.color } : {}),
          ...(d.appliedSkills && d.appliedSkills.length > 0 ? { appliedSkills: d.appliedSkills } : {}),
          ...(d.effort ? { effort: normalizeReasoningLevel(d.effort) } : {}),
          ...(d.permissionMode ? { permissionMode: d.permissionMode } : {}),
          ...(d.assignedWorktree ? { assignedWorktree: d.assignedWorktree, assignedWorktreePath: d.assignedWorktreePath ?? null, baseBranch: d.baseBranch ?? null } : {}),
          ...(d.resumeSessionId ? { resumeSessionId: d.resumeSessionId } : {}),
          ...(d.account ? { account: d.account } : {}),
        };
      }
      if (n.type === "plan") {
        const d = n.data as { title?: string; steps?: unknown; ownerBindings?: unknown };
        const bindings = d.ownerBindings && typeof d.ownerBindings === "object"
          ? (d.ownerBindings as Record<string, string>)
          : undefined;
        const steps: CanvasPlanStep[] = Array.isArray(d.steps)
          ? (d.steps as unknown[]).map((s) => {
              const step = s as Record<string, unknown>;
              return {
                title: String(step.title ?? ""),
                ...(typeof step.owner === "string" ? { owner: step.owner } : {}),
                ...(typeof step.done === "boolean" ? { done: step.done } : {}),
              };
            })
          : [];
        return {
          type: "plan" as const,
          id: n.id, position, size,
          title: typeof d.title === "string" ? d.title : "Plan",
          steps,
          ...(bindings && Object.keys(bindings).length > 0 ? { ownerBindings: bindings } : {}),
        };
      }
      if (n.type === "run") {
        const d = n.data as { title?: unknown; memberIds?: unknown; brief?: unknown; budgetCap?: unknown; open?: unknown };
        const budgetCap = normalizeBudgetCap(d.budgetCap);
        return {
          type: "run" as const,
          id: n.id, position, size,
          title: typeof d.title === "string" ? d.title : "Run",
          memberIds: Array.isArray(d.memberIds) ? d.memberIds.filter((m): m is string => typeof m === "string") : [],
          ...(typeof d.brief === "string" && d.brief.trim() ? { brief: d.brief } : {}),
          ...(budgetCap !== undefined ? { budgetCap } : {}),
          ...(d.open === true ? { open: true } : {}),
        };
      }
      if (n.type === "task") {
        const d = n.data as {
          title?: string; description?: string; status?: CanvasTaskStatus;
          priority?: CanvasTaskPriority; taskId?: string; taskWorkspaceId?: string; dispatchedAgentIds?: string[];
          intent?: string; taskClass?: string; when?: string;
          acceptanceCriteria?: Array<{ id: string; text: string; done: boolean }>;
        };
        const criteria: AcceptanceCriterion[] | undefined = Array.isArray(d.acceptanceCriteria)
          ? d.acceptanceCriteria.map((c) => ({ id: String(c.id), text: String(c.text), done: !!c.done }))
          : undefined;
        return {
          type: "task" as const,
          id: n.id, position, size,
          title: typeof d.title === "string" ? d.title : "Task",
          description: typeof d.description === "string" ? d.description : "",
          status: d.status ?? "todo",
          priority: d.priority ?? "none",
          ...(d.taskId ? { taskId: d.taskId } : {}),
          ...(d.taskWorkspaceId ? { taskWorkspaceId: d.taskWorkspaceId } : {}),
          ...(d.dispatchedAgentIds && d.dispatchedAgentIds.length > 0 ? { dispatchedAgentIds: d.dispatchedAgentIds } : {}),
          ...(typeof d.intent === "string" ? { intent: d.intent } : {}),
          ...(typeof d.taskClass === "string" ? { taskClass: d.taskClass as TaskClass } : {}),
          ...(typeof d.when === "string" ? { when: d.when as TaskWhen } : {}),
          ...(criteria ? { acceptanceCriteria: criteria } : {}),
        };
      }
      if (n.type === "team") {
        const d = n.data as { cwd?: string; teamId?: string; name?: string; description?: string; goal?: string; members?: AgentDefinition[] };
        const members: AgentDefinition[] = Array.isArray(d.members)
          ? (d.members as unknown[]).map((m) => {
              const mb = m as Record<string, unknown>;
              return {
                id: String(mb.id ?? ""),
                name: String(mb.name ?? "Agent"),
                ...(typeof mb.role === "string" ? { role: mb.role } : {}),
                model: String(mb.model ?? ""),
                prompt: String(mb.prompt ?? ""),
                appliedSkills: Array.isArray(mb.appliedSkills) ? (mb.appliedSkills as unknown[]).map(String) : [],
                ...(typeof mb.effort === "string" ? { effort: normalizeReasoningLevel(mb.effort) } : {}),
                ...(typeof mb.permissionMode === "string" ? { permissionMode: mb.permissionMode } : {}),
                ...(typeof mb.runner === "string" ? { runner: mb.runner as AgentDefinition["runner"] } : {}),
                ...(typeof mb.runnerCommand === "string" ? { runnerCommand: mb.runnerCommand } : {}),
                updatedAt: typeof mb.updatedAt === "number" ? mb.updatedAt : 0,
              };
            })
          : [];
        return {
          type: "team" as const,
          id: n.id, position, size,
          cwd: d.cwd ?? rootDir,
          ...(typeof d.teamId === "string" ? { teamId: d.teamId } : {}),
          name: typeof d.name === "string" ? d.name : "Agent Team",
          description: typeof d.description === "string" ? d.description : "Coordinated team run",
          goal: typeof d.goal === "string" ? d.goal : "Complete the approved workflow step.",
          members,
        };
      }
      if (n.type === "context") {
        const d = n.data as { title?: string };
        return {
          type: "context" as const,
          id: n.id, position, size,
          title: typeof d.title === "string" ? d.title : "Context Bus",
        };
      }
      if (n.type === "critic") {
        const d = n.data as { title?: string; model?: string };
        return {
          type: "critic" as const,
          id: n.id, position, size,
          title: typeof d.title === "string" ? d.title : "Critic",
          ...(typeof d.model === "string" ? { model: d.model } : {}),
        };
      }
      if (n.type === "human-gate") {
        const d = n.data as { title?: string; instructions?: string; gateKind?: "clarification" | "approval"; status?: "idle" | "waiting" | "approved" | "rejected" };
        return {
          type: "human-gate" as const,
          id: n.id, position, size,
          title: typeof d.title === "string" ? d.title : "Human Approval",
          instructions: typeof d.instructions === "string" ? d.instructions : "Review the upstream output and approve or reject this gate.",
          gateKind: d.gateKind ?? "approval",
          status: d.status ?? "idle",
        };
      }
      if (n.type === "browser") {
        const d = n.data as {
          parentTerminalId?: string;
          url?: string;
          browserNumber?: number;
          label?: string;
          viewportMode?: "auto" | "desktop" | "tablet" | "mobile" | "custom";
          viewportOrientation?: "landscape" | "portrait";
          viewportWidth?: number;
          viewportHeight?: number;
          viewportScaleMode?: "fit" | "actual" | "fill";
          viewportZoom?: number | null;
        };
        return {
          type: "browser" as const,
          id: n.id, position, size,
          parentTerminalId: typeof d.parentTerminalId === "string" ? d.parentTerminalId : null,
          url: typeof d.url === "string" ? d.url : "",
          browserNumber: d.browserNumber ?? 1,
          state: "disconnected" as const,
          ...(typeof d.label === "string" && d.label.trim() ? { label: d.label.trim() } : {}),
          ...(d.viewportMode ? { viewportMode: d.viewportMode } : {}),
          ...(d.viewportOrientation ? { viewportOrientation: d.viewportOrientation } : {}),
          ...(typeof d.viewportWidth === "number" && Number.isFinite(d.viewportWidth) ? { viewportWidth: d.viewportWidth } : {}),
          ...(typeof d.viewportHeight === "number" && Number.isFinite(d.viewportHeight) ? { viewportHeight: d.viewportHeight } : {}),
          ...(d.viewportScaleMode ? { viewportScaleMode: d.viewportScaleMode } : {}),
          ...(typeof d.viewportZoom === "number" && Number.isFinite(d.viewportZoom) ? { viewportZoom: d.viewportZoom } : {}),
        };
      }
      if (n.type === "music") {
        const d = n.data as { activeTrackId?: string; volume?: number };
        return {
          type: "music" as const,
          id: n.id, position, size,
          ...(typeof d.activeTrackId === "string" && d.activeTrackId ? { activeTrackId: d.activeTrackId } : {}),
          ...(typeof d.volume === "number" && Number.isFinite(d.volume) ? { volume: d.volume } : {}),
        };
      }
      if (n.type === "host-cell") {
        const d = n.data as { adoptedPaneId?: string; cwd?: string; label?: string; provider?: string };
        return {
          type: "host-cell" as const,
          id: n.id, position, size,
          adoptedPaneId: d.adoptedPaneId ?? "",
          cwd: d.cwd ?? "",
          label: d.label ?? "",
          provider: d.provider ?? "",
        };
      }
      if (n.type === "factory") {
        const d = n.data as { repo?: string; issue?: number | string; title?: string };
        return {
          type: "factory" as const,
          id: n.id, position, size,
          repo: d.repo ?? "",
          issue: d.issue ?? 0,
          title: d.title ?? "",
        };
      }
      if (n.type === "file") {
        // Path and scroll position only: the text is read from disk, never saved on the board.
        const d = n.data as { path?: unknown; viewport?: { topLine?: unknown } };
        const topLine = d.viewport?.topLine;
        return {
          type: "file" as const,
          id: n.id, position, size,
          path: typeof d.path === "string" ? d.path : "",
          ...(typeof topLine === "number" && Number.isFinite(topLine) && topLine > 0 ? { viewport: { topLine: Math.floor(topLine) } } : {}),
        };
      }
      if (n.type === "frame") {
        const d = n.data as { title?: unknown; colorId?: unknown; diagramId?: unknown; taskKey?: unknown };
        return {
          type: "frame" as const,
          id: n.id, position, size,
          title: typeof d.title === "string" ? d.title : "",
          ...(typeof d.colorId === "string" && d.colorId ? { colorId: d.colorId } : {}),
          ...(typeof d.diagramId === "string" && d.diagramId ? { diagramId: d.diagramId } : {}),
          ...(typeof d.taskKey === "string" && d.taskKey ? { taskKey: d.taskKey } : {}),
        };
      }
      if (n.type === "shape") {
        const d = n.data as { shape?: CanvasShapeKind; text?: string; angle?: number; areaLabel?: string; points?: Array<[number, number]>; style?: CanvasShapeStyle; shapeNumber?: number; diagramId?: string; diagramFrame?: boolean; diagramNodeId?: string; imageAssetUri?: string; imageAlt?: string; imageNaturalWidth?: number; imageNaturalHeight?: number };
        return {
          type: "shape" as const,
          id: n.id, position, size,
          shape: d.shape ?? "rectangle",
          ...(typeof d.text === "string" ? { text: d.text } : {}),
          ...(typeof d.angle === "number" && Number.isFinite(d.angle) && d.angle !== 0 ? { angle: d.angle } : {}),
          ...(typeof d.areaLabel === "string" ? { areaLabel: d.areaLabel } : {}),
          ...(Array.isArray(d.points) ? { points: d.points } : {}),
          ...(d.style && typeof d.style === "object" ? { style: d.style } : {}),
          // Image shape: the asset URI must survive serialization so the note-asset GC (which scans
          // the snapshot for `lotus-note-asset://` refs) keeps the bytes and reload can re-render.
          ...(typeof d.imageAssetUri === "string" && d.imageAssetUri ? { imageAssetUri: d.imageAssetUri } : {}),
          ...(typeof d.imageAlt === "string" ? { imageAlt: d.imageAlt } : {}),
          ...(typeof d.imageNaturalWidth === "number" ? { imageNaturalWidth: d.imageNaturalWidth } : {}),
          ...(typeof d.imageNaturalHeight === "number" ? { imageNaturalHeight: d.imageNaturalHeight } : {}),
          ...(d.shapeNumber ? { shapeNumber: d.shapeNumber } : {}),
          ...(typeof d.diagramId === "string" && d.diagramId ? { diagramId: d.diagramId } : {}),
          ...(d.diagramFrame === true ? { diagramFrame: true } : {}),
          ...(typeof d.diagramNodeId === "string" && d.diagramNodeId ? { diagramNodeId: d.diagramNodeId } : {}),
        };
      }
      return {
        type: "note" as const,
        id: n.id, position, size,
        content: noteContent.get(n.id) ?? "",
        ...((n.data as { noteNumber?: number }).noteNumber ? { noteNumber: (n.data as { noteNumber: number }).noteNumber } : {}),
        ...(typeof (n.data as { editedAt?: unknown }).editedAt === "number" ? { editedAt: (n.data as { editedAt: number }).editedAt } : {}),
        ...(typeof (n.data as { coverUri?: unknown }).coverUri === "string" && (n.data as { coverUri: string }).coverUri
          ? { coverUri: (n.data as { coverUri: string }).coverUri }
          : {}),
        ...(typeof (n.data as { editedBy?: unknown }).editedBy === "string" && (n.data as { editedBy: string }).editedBy
          ? { editedBy: (n.data as { editedBy: string }).editedBy }
          : {}),
      };
    })
    // Frame membership and the spawn-task stamp live in node data for every kind; one place writes
    // them so no kind can forget.
    .map((record, i): CanvasNodeRecord => {
      if (record.type === "frame") return record;
      const data = live[i].data as { frameId?: unknown; spawnTaskKey?: unknown; spawnTaskTitle?: unknown } | undefined;
      const withFrame = typeof data?.frameId === "string" && data.frameId ? { ...record, frameId: data.frameId } : record;
      return typeof data?.spawnTaskKey === "string" && data.spawnTaskKey
        ? { ...withFrame, spawnTaskKey: data.spawnTaskKey, ...(typeof data.spawnTaskTitle === "string" && data.spawnTaskTitle ? { spawnTaskTitle: data.spawnTaskTitle } : {}) }
        : withFrame;
    });

  const persistEdges = edges
    .filter((e) => !ephemeralIds.has(e.source) && !ephemeralIds.has(e.target))
    .map((e) => {
      const edgeData = e.data as { wireKind?: string; customLabel?: string } | undefined;
      const kind = edgeData?.wireKind;
      const customLabel = edgeData?.customLabel;
      return {
        id: e.id, source: e.source, target: e.target,
        ...(kind && kind !== "default" ? { kind } : {}),
        ...(typeof customLabel === "string" ? { label: customLabel } : {}),
        ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
        ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
      };
    });

  return { schemaVersion: 1, id, rootDir, nodes: records, edges: persistEdges, terminalCounter, agentCounter, noteCounter, browserCounter, shapeCounter };
}
