"use client";
import { useCallback, useMemo } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";

interface Options {
  projects: CodeCanvasProjectMeta[];
  activeProjectId: string | null;
  activeProject: CodeCanvasProjectMeta | null;
  loading: boolean;
  /** True once the first cold boot completed. Gates the "Restoring canvas…" splash to boot only. */
  booted?: boolean;
  showPicker: boolean;
  nodes: Node[];
  edges: Edge[];
  closeProject: (projectId: string) => Promise<unknown>;
}

export function useCanvasProjectSidebarActions({
  projects,
  activeProjectId,
  activeProject,
  loading,
  booted = false,
  showPicker,
  nodes,
  edges,
  closeProject,
}: Options) {
  const nodeCountsByProject = useMemo(
    () => new Map(projects.map((project) => [project.id, project.id === activeProjectId ? nodes.length : 0])),
    [activeProjectId, nodes.length, projects],
  );
  // Only splash "Restoring canvas…" on the very first cold boot. A project switch (or a return to
  // the page) keeps the current canvas painted while the next snapshot loads and swaps in, so the
  // transition reads as instant instead of flashing a loading screen.
  const showRestoringState = loading && !booted;
  const showEmptyState = !showRestoringState && (showPicker || !activeProject);

  const handleCloseProject = useCallback((projectId: string) => {
    const hasCanvasData = projectId === activeProjectId && (nodes.length > 0 || edges.length > 0);
    if (hasCanvasData && !window.confirm("Close workspace?\n\nThis removes the canvas layout and notes for this workspace. The folder on disk is not deleted.")) return;
    void closeProject(projectId);
  }, [activeProjectId, closeProject, edges.length, nodes.length]);

  const handleCopyProjectPath = useCallback((projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    if (project) void navigator.clipboard?.writeText(project.rootDir);
  }, [projects]);

  return { nodeCountsByProject, showEmptyState, showRestoringState, handleCloseProject, handleCopyProjectPath };
}
