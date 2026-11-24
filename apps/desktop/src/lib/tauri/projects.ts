import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";
import type { ProjectMeta } from "@/lib/tauri-api";

export async function listProjects(): Promise<ProjectMeta[]> {
  return tauriInvoke<ProjectMeta[]>("list_projects");
}

export async function listProjectDirectoryPaths(
  projectPath: string,
  relativePath?: string,
  maxDepth = 3,
): Promise<string[]> {
  if (!isTauri()) {
    return [];
  }

  return tauriInvoke<string[]>("list_project_directory", {
    projectPath,
    relativePath,
    maxDepth,
  });
}
