const DEFAULT_CANVAS_RUNTIME_SCOPE = "canvas:default";

export function canvasRuntimeScope(projectId: string | null | undefined): string {
  return projectId ? `canvas:${projectId}` : DEFAULT_CANVAS_RUNTIME_SCOPE;
}

export function canvasRuntimePaneId(projectId: string | null | undefined, nodeId: string): string {
  return projectId ? `${canvasRuntimeScope(projectId)}:${nodeId}` : nodeId;
}

/**
 * The inverse of [canvasRuntimeScope]: `canvas:cp_1` → `cp_1`.
 *
 * Remote callers speak workspace ids (that is what the fleet publishes), while everything
 * that switches a board speaks project ids. Without this the two vocabularies get compared
 * directly somewhere and the comparison quietly never matches.
 *
 * Returns `null` for anything that is not a canvas scope — including the default scope,
 * which names no project.
 */
export function projectIdFromCanvasScope(workspaceId: string | null | undefined): string | null {
  if (!workspaceId) return null;
  const trimmed = workspaceId.trim();
  if (!trimmed.startsWith("canvas:")) return null;
  const projectId = trimmed.slice("canvas:".length);
  return projectId.length > 0 && projectId !== "default" ? projectId : null;
}

/**
 * Which project a pane belongs to: `canvas:cp_1:node-9` → `cp_1`.
 *
 * Separate from [projectIdFromCanvasScope] because a pane id carries one more segment,
 * and feeding it to that function returns `cp_1:node-9` — a project id that matches
 * nothing, silently. `null` for a bare node id, which is what an unscoped pane looks like.
 */
export function projectIdFromCanvasPaneId(paneId: string | null | undefined): string | null {
  if (!paneId) return null;
  const parts = paneId.trim().split(":");
  if (parts.length < 3 || parts[0] !== "canvas") return null;
  const projectId = parts[1] ?? "";
  return projectId.length > 0 && projectId !== "default" ? projectId : null;
}
