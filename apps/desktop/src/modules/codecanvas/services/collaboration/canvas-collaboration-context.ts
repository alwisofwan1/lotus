import type { BridgeTask } from "@/lib/tauri-api";
import type { CanvasCollaborationLaunch } from "../canvas-collaboration-launch";

export interface CanvasCollaborationContextRecord {
  runId: string;
  launch: {
    mode: Exclude<CanvasCollaborationLaunch["mode"], "off">;
    sourceLabel: string;
    taskId?: string;
    workflowId?: string;
    workspaceId?: string;
  };
  task?: {
    id: string;
    workspaceId: string;
    title: string;
    goal: string;
    knowledge?: string;
    status: BridgeTask["status"];
    priority: BridgeTask["priority"];
    assignees: string[];
    updatedAt: number;
  };
  updatedAt: number;
}

export interface BuildCanvasCollaborationContextInput {
  launch: CanvasCollaborationLaunch;
  runId: string | null;
  task?: BridgeTask | null;
  now?: number;
}

function taskSummary(task: BridgeTask): CanvasCollaborationContextRecord["task"] {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    title: task.title,
    goal: task.goal,
    ...(task.knowledge ? { knowledge: task.knowledge } : {}),
    status: task.status,
    priority: task.priority,
    assignees: task.assignees,
    updatedAt: task.updatedAt,
  };
}

export function buildCanvasCollaborationContextRecord(
  input: BuildCanvasCollaborationContextInput,
): CanvasCollaborationContextRecord | null {
  if (!input.runId || input.launch.mode === "off") return null;
  return {
    runId: input.runId,
    launch: {
      mode: input.launch.mode,
      sourceLabel: input.launch.sourceLabel,
      ...(input.launch.taskId ? { taskId: input.launch.taskId } : {}),
      ...(input.launch.workflowId ? { workflowId: input.launch.workflowId } : {}),
      ...(input.launch.workspaceId ? { workspaceId: input.launch.workspaceId } : {}),
    },
    ...(input.task ? { task: taskSummary(input.task) } : {}),
    updatedAt: input.now ?? Date.now(),
  };
}
