export type CanvasCollaborationMode = "off" | "swarm-task" | "swarm-workflow" | "manual";

export type CanvasCollaborationLaunch =
  | { mode: "off" }
  | {
      mode: Exclude<CanvasCollaborationMode, "off">;
      sourceLabel: string;
      autoOpenPanel: boolean;
      taskId?: string;
      workspaceId?: string;
      workflowId?: string;
    };

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function collaborationMode(value: string | null): CanvasCollaborationMode {
  switch (clean(value)) {
    case "swarm-task":
      return "swarm-task";
    case "swarm-workflow":
      return "swarm-workflow";
    case "manual":
      return "manual";
    case "1":
    case "true":
      return "manual";
    default:
      return "off";
  }
}

function sourceLabelFor(mode: Exclude<CanvasCollaborationMode, "off">): string {
  switch (mode) {
    case "swarm-task":
      return "Swarm task";
    case "swarm-workflow":
      return "Swarm workflow";
    case "manual":
      return "Manual collaboration";
  }
}

/**
 * Resolves whether CodeCanvas should reveal collaboration UI for this launch.
 * Ordinary canvas/workflow routes intentionally stay clean; only explicit
 * collaboration query params opt into the ledger projection.
 */
export function resolveCanvasCollaborationLaunch(params: URLSearchParams): CanvasCollaborationLaunch {
  const mode = collaborationMode(params.get("collab"));
  if (mode === "off") return { mode: "off" };

  const workflowId = clean(params.get("workflowId")) ?? clean(params.get("run")) ?? clean(params.get("workflow")) ?? undefined;
  const taskId = clean(params.get("task")) ?? clean(params.get("taskId")) ?? undefined;
  const workspaceId = clean(params.get("workspace")) ?? clean(params.get("workspaceId")) ?? undefined;

  if (mode === "swarm-task" && !taskId) return { mode: "off" };
  if (mode === "swarm-workflow" && !workflowId) return { mode: "off" };

  return {
    mode,
    sourceLabel: sourceLabelFor(mode),
    autoOpenPanel: true,
    ...(taskId ? { taskId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workflowId ? { workflowId } : {}),
  };
}
