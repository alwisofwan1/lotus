/**
 * `projects` as `/m/bootstrap` sends it, from either shape the desktop may answer with.
 * Shared with the structured spawn, which resolves a workspace to its directory.
 */
import { str } from "./http-util.js";

/**
 * One project shape for the phone, from two hosts that describe projects differently
 * (desktop `{ items: [...] }` registry vs a standalone's bare `HostedProject[]`).
 * `lastOpenedAt` is `0` where a host cannot know it, so such projects sort last.
 */
export function normalizeProjects(raw: unknown): Array<{
  workspaceId: string;
  name: string;
  path: string;
  lastOpenedAt: number;
}> {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown } | null)?.items)
      ? ((raw as { items: unknown[] }).items)
      : [];

  return list.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const project = entry as Record<string, unknown>;
    // `workspaceId` is what a cell reports; a standalone's `id` is the only key it
    // has. Whichever is present is the join key, and a project with neither cannot
    // be selected at all — so it is dropped rather than shown as unreachable.
    const workspaceId = str(project["workspaceId"]) ?? str(project["id"]);
    const path = str(project["path"]) ?? "";
    const name = str(project["name"]);
    if (workspaceId === undefined || name === undefined) return [];
    const lastOpenedAt = project["lastOpenedAt"];
    return [{
      workspaceId,
      name,
      path,
      lastOpenedAt: typeof lastOpenedAt === "number" ? lastOpenedAt : 0,
    }];
  });
}

