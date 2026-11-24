/**
 * `projects` as `/m/bootstrap` sends it, from either shape the desktop may answer with.
 *
 * Moved out of `http-routes.ts` on 2026-08-27 when the structured spawn needed the same
 * normalisation to resolve a workspace to its directory — and that file was at the
 * 300-line ceiling.
 */
import { str } from "./http-util.js";

/**
 * One project shape for the phone, from two hosts that describe projects differently.
 *
 * A desktop answers `{ items: [{ workspaceId, name, path, lastOpenedAt }] }` — its
 * CodeCanvas registry. A Standalone Host answers a bare `HostedProject[]` from its
 * `PROJECTS_ROOT` scan, which has `id`/`name`/`path` and no notion of when a project
 * was last opened. Both are legitimate answers to "what projects exist here", so the
 * normalisation happens once, here, rather than as a fork inside the client.
 *
 * `lastOpenedAt` is `0` where a host cannot know it. That is honest and it sorts
 * correctly: a standalone's projects fall to the bottom of a most-recent-first list,
 * which is exactly where projects with no recorded activity belong.
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

