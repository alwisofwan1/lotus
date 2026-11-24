import type { Node } from "@xyflow/react";
import { codespaceGitPanelRefresh, type CodespaceGitPanelRefresh } from "@/lib/tauri/codespace";
import { codespaceGitPanelRefreshSsh } from "@/lib/tauri/codespace-git-ssh";
import { getActiveProjectLocation } from "./canvas-active-project";
import type { AgentProfile, WorkspaceContext } from "./refine-dispatch-prompt";
import type { CanvasAgentNodeData } from "../types/canvas";

/**
 * Builds the target agent's profile (Fase 3) from its live canvas node — runner, model, applied
 * skills, and role when present — so the rewrite can be framed for how that agent works. Name falls
 * back to the roster. Returns undefined when nothing useful is known.
 */
export function buildAgentProfile(
  agentId: string,
  nodes: Node[],
  roster: { id: string; name: string }[],
): AgentProfile | undefined {
  const data = nodes.find((node) => node.id === agentId)?.data as CanvasAgentNodeData | undefined;
  const name = data?.name ?? roster.find((agent) => agent.id === agentId)?.name;

  const profile: AgentProfile = {
    name,
    role: typeof data?.role === "string" ? data.role : undefined,
    runner: data?.runner,
    model: data?.model,
    skills: Array.isArray(data?.appliedSkills) && data.appliedSkills.length > 0 ? data.appliedSkills : undefined,
  };

  return profile.name || profile.runner || profile.role || profile.skills ? profile : undefined;
}

/**
 * Gathers live workspace context for dispatch prompt refinement (Fase 2): git state (branch,
 * ahead/behind, changed files) via the existing one-shot panel-refresh command, plus the labels of
 * nodes currently selected on the canvas. Best-effort — git failures (no repo, browser dev) are
 * swallowed and simply omitted. Bounded so the refine prompt stays small.
 */

const MAX_CHANGED_FILES = 6;
const MAX_SELECTION = 6;

function selectedNodeLabels(nodes: Node[]): string[] {
  return nodes
    .filter((node) => node.selected)
    .slice(0, MAX_SELECTION)
    .map((node) => {
      const data = node.data as { name?: string; title?: string; label?: string } | undefined;
      const name = (data?.name ?? data?.title ?? data?.label ?? "").trim();
      const kind = node.type ?? "node";
      return name ? `${kind} ${name}` : kind;
    });
}

export async function gatherDispatchWorkspaceContext(opts: { rootDir: string; nodes: Node[] }): Promise<WorkspaceContext> {
  const context: WorkspaceContext = {};

  const root = opts.rootDir?.trim();
  if (root) {
    try {
      // The branch and changed files a dispatch prompt is framed against are the ones on the
      // project's machine. Asking this one would quietly describe the wrong repo — and a prompt
      // built on the wrong branch is worse than a prompt with no git context at all.
      const machine = getActiveProjectLocation();
      const panel: CodespaceGitPanelRefresh | null = machine
        ? await codespaceGitPanelRefreshSsh({
            target: { host: machine.host, user: machine.user ?? null, port: machine.port ?? null },
            repoRoot: root,
          })
        : await codespaceGitPanelRefresh(root);
      if (panel) {
        const files = panel.files.map((file) => file.relativePath).filter(Boolean);
        context.git = {
          branch: panel.summary.branch,
          ahead: panel.summary.ahead,
          behind: panel.summary.behind,
          upstream: panel.summary.upstream ?? undefined,
          changedCount: files.length,
          changedFiles: files.slice(0, MAX_CHANGED_FILES),
        };
      }
    } catch {
      /* not a git repo / command unavailable — omit git context */
    }
  }

  const selection = selectedNodeLabels(opts.nodes);
  if (selection.length > 0) context.selection = selection;

  return context;
}
