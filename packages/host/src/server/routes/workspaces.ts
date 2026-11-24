import type { ServerResponse } from "node:http";
import type { PtyManager } from "../pty/manager.js";
import type { ProjectRegistry } from "../projects/registry.js";
import type { RouteHandler } from "../router.js";
import type { BridgeProvider, ListWorkspacesResponse, WorkspaceSummary } from "../../types/index.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function listWorkspacesHandler(
  ptyManager: PtyManager,
  projectRegistry: ProjectRegistry,
): RouteHandler {
  return (_req, res): void => {
    const byWorkspace = new Map<string, WorkspaceSummary>();

    for (const project of projectRegistry.list()) {
      byWorkspace.set(project.id, {
        workspaceId: project.id,
        cellCount: 0,
        providers: [],
      });
    }

    for (const session of ptyManager.list()) {
      const workspaceId = session.workspaceId ?? session.cwd;
      const provider = session.provider ?? "claude";
      const current = byWorkspace.get(workspaceId) ?? {
        workspaceId,
        cellCount: 0,
        providers: [],
      };
      current.cellCount += 1;
      if (!current.providers.includes(provider)) current.providers.push(provider);
      current.providers.sort(compareProvider);
      byWorkspace.set(workspaceId, current);
    }

    const body: ListWorkspacesResponse = {
      items: [...byWorkspace.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    };
    sendJson(res, 200, body);
  };
}

function compareProvider(a: BridgeProvider, b: BridgeProvider): number {
  return a.localeCompare(b);
}
