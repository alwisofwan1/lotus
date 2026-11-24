import type { FoundCheckout, PaneRequest } from "./automation-api";

/**
 * Opens a run's pane when Rust asks (an automation that belongs to a project runs there, where the
 * user can watch it — as bb runs an automation as a thread), and reports back so the run either
 * waits for the agent or fails with a reason the user can act on. Every path answers: a run that is
 * never told anything would sit until its open timeout.
 *
 * A run about a repository (a PR review) opens where that repository is checked out, when it is:
 * a workspace that is the checkout, or a folder inside one (`acme-main/acme-web`). Otherwise
 * it opens in the automation's project.
 */

export type RunPaneWorkspace = { cwd: string; remote: boolean; name?: string };

/** The grid, from the mode that owns it; null until that mode has mounted. */
export type RunPaneGrid = {
  /** The workspace's folder, or null when it is not in the rail. */
  workspace: (id: string) => RunPaneWorkspace | null;
  /** Every workspace in the rail, to look for a checkout in. */
  workspaces?: () => ({ id: string } & RunPaneWorkspace)[];
  addPane: (workspaceId: string, command: string, cwd?: string) => string | null;
};

/** Where the answer goes, and the checkout search: always available, grid or not. */
export type RunPaneReport = {
  opened: (token: string, cwd: string, workspaceId: string) => Promise<void>;
  failed: (token: string, reason: string) => Promise<void>;
  findCheckout?: (repo: string, workspaces: { id: string; cwd: string }[], preferred: string | null) => Promise<FoundCheckout | null>;
};

export async function openRunPane(request: PaneRequest, grid: RunPaneGrid | null, report: RunPaneReport): Promise<void> {
  const fail = (reason: string) => report.failed(request.token, reason);
  if (!grid) return fail("Lotus has no workspace grid open yet; the run could not open a pane.");

  let target: { workspaceId: string; cwd?: string } = { workspaceId: request.workspaceId };
  if (request.repo && report.findCheckout && grid.workspaces) {
    // Only local workspaces: the prompt file the pane reads lives on this machine.
    const local = grid.workspaces().filter((w) => !w.remote).map(({ id, cwd }) => ({ id, cwd }));
    // A failed search is not a failed run: the automation's project is still a fine place.
    const found = await report.findCheckout(request.repo, local, request.workspaceId).catch(() => null);
    if (found) target = found;
  }

  const workspace = grid.workspace(target.workspaceId);
  if (!workspace) {
    return fail("This automation's project is not open in Lotus. Open it in the sidebar, then run the automation again.");
  }
  if (workspace.remote) return fail("This automation's project is on a remote machine; automations run only in local projects.");
  let paneId: string | null;
  try {
    paneId = grid.addPane(target.workspaceId, request.command, target.cwd);
  } catch (error) {
    return fail(`Could not open a pane: ${String(error)}`);
  }
  if (!paneId) return fail("Could not open a pane in this automation's project.");
  await report.opened(request.token, target.cwd ?? workspace.cwd, target.workspaceId);
}
