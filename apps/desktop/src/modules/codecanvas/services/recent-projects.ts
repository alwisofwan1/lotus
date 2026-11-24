import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";

/** A project row shown in the "No project open" portal: ready to render, no path logic left. */
export interface RecentProject {
  id: string;
  /** alias, else the last path segment of the root dir. */
  name: string;
  /** the parent directory of the root, tildified when it sits under $HOME. */
  path: string;
}

/** alias wins; otherwise the trailing path segment; otherwise the raw root. */
export function projectDisplayName(project: CodeCanvasProjectMeta): string {
  return project.alias || project.rootDir.split(/[\\/]/).filter(Boolean).at(-1) || project.rootDir;
}

/** Collapse a leading $HOME to "~" (handles both / and \ separators); pass-through otherwise. */
function tildify(path: string, home: string | null): string {
  if (!home) return path;
  const h = home.replace(/[\\/]+$/, "");
  if (path === h) return "~";
  if (path.startsWith(`${h}/`) || path.startsWith(`${h}\\`)) return `~${path.slice(h.length)}`;
  return path;
}

/** The directory containing `rootDir` (its parent), or the root itself when at the top. */
function parentDir(rootDir: string): string {
  const trimmed = rootDir.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

/**
 * Most-recently-opened projects, newest first, capped and shaped for the empty-state portal.
 * Excludes `excludeId` (the currently active project, if any) so the list is only alternatives.
 */
export function buildRecentProjects(
  projects: CodeCanvasProjectMeta[],
  opts: { home?: string | null; limit?: number; excludeId?: string | null } = {},
): RecentProject[] {
  const { home = null, limit = 3, excludeId = null } = opts;
  return projects
    .filter((p) => p.id !== excludeId)
    .slice()
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, Math.max(0, limit))
    .map((p) => ({ id: p.id, name: projectDisplayName(p), path: tildify(parentDir(p.rootDir), home) }));
}
