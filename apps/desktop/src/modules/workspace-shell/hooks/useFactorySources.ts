"use client";
import { useCallback, useMemo } from "react";
import {
  createFactoryRunStarter,
  notionTicketBody,
  type FactoryAgentsSource,
  type FactoryNewRunSource,
} from "@/modules/factory";
import {
  factoryAgentSave,
  factoryCatalog,
  factoryDefinitionView,
  factoryGitSubfolders,
  factoryNotionTicket,
  factoryPrivateSetup,
  factoryCheckSuggestions,
  factoryCheckPreview,
  factoryCheckStart,
  factoryCheckStatus,
  factoryCheckCancel,
  factoryGateSave,
  factoryPrivateRemove,
  factoryPrivateRestore,
  factorySharedSave,
  graphRunStart,
} from "@/lib/tauri/graph-run";
import { getSettings } from "@/lib/tauri-api";
import type { AutomationClient } from "@/modules/automation/services/automation-api";
import { localProjectIdForRoot } from "@/modules/codecanvas/services/codecanvas-project-repository";
import { resolveDelegationPresets, supportsChosenSession } from "@/modules/tasks/services/delegation-preset";
import { notionVocabulary } from "@/modules/tasks/services/notion-source";
import type { ClaudeSettings } from "@/modules/settings/types";
import type { SharedTrackerBoard } from "./TrackerBoardProvider";

type TicketText = { title: string; body: string; notion?: { pageId: string; url: string } };

export interface FactorySources {
  /** What a run's actions read a ticket with: a Notion key, or a GitHub issue number in `repo`. */
  readIssue: (repo: string, number: number | string) => Promise<TicketText | null>;
  /** New run: the GitHub repos and Notion boards Tasks has, their open tickets, and the starter. */
  newRun: FactoryNewRunSource;
  /** Settings: each repo's factory definition, in the checkout a local workspace holds (FI5). */
  agents: FactoryAgentsSource;
}

/**
 * Factory's sources, built from the window's one tracker board, so every host of the Factory sees
 * the same ticket sources: Code's panel and the Canvas Dock. The Dock built none of this and its
 * Settings tab said "Add a GitHub ticket source" on a board that had one.
 */
export function useFactorySources(shared: SharedTrackerBoard, automationClient: AutomationClient): FactorySources {
  const { board, notionSources, githubSources, workspaceFolders } = shared;
  // A Notion ticket for a run (#168): found by its key in the tickets Tasks last read, then read in
  // full (page + properties). Read only — nothing is written to Notion.
  const readNotionTicket = useCallback(
    async (key: string, sourceId?: string) => {
      const task = board.tasks.find(
        (t) =>
          t.key === key &&
          (sourceId ? t.projectId === sourceId : notionSources.some((s) => s.id === t.projectId)),
      );
      if (!task) return null;
      const text = await factoryNotionTicket(task.id);
      return { title: text.title || task.title, body: notionTicketBody(text), notion: { pageId: task.id, url: text.url } };
    },
    [board.tasks, notionSources],
  );
  const readIssue = useCallback(
    async (repo: string, number: number | string) => {
      if (typeof number === "string") return readNotionTicket(number);
      const source = githubSources.find((s) => s.repo.toLowerCase() === repo.toLowerCase());
      if (!source) return null;
      const opened = await board.openTask(source.id, String(number));
      return opened?.kind === "github" ? { title: opened.issue.title, body: opened.issue.body } : null;
    },
    [board, githubSources, readNotionTicket],
  );
  // New run reads the same GitHub issue list Tasks shows, and starts in the checkout a local workspace holds.
  const factoryCheckout = useCallback(
    async (repo: string) => {
      const local = workspaceFolders().filter((w) => !w.remote).map(({ id, cwd }) => ({ id, cwd }));
      return (await automationClient.findCheckout(repo, local, null))?.cwd ?? null;
    },
    [automationClient, workspaceFolders],
  );
  const factoryPresets = useCallback(
    async () =>
      resolveDelegationPresets((await getSettings()) as ClaudeSettings)
        .filter(supportsChosenSession)
        .map(({ id, name }) => ({ id, name })),
    [],
  );
  const newRun = useMemo<FactoryNewRunSource>(() => {
    const start = createFactoryRunStarter({
      findCheckout: factoryCheckout,
      projectIdOf: localProjectIdForRoot,
      readIssue: async (sourceId, number) => {
        if (typeof number === "string") return readNotionTicket(number, sourceId);
        const opened = await board.openTask(sourceId, String(number));
        return opened?.kind === "github" ? { title: opened.issue.title, body: opened.issue.body } : null;
      },
      start: graphRunStart,
    });
    return {
      repos: githubSources.map(({ id, repo, account, name }) => ({ id, repo, account, name })),
      notion: notionSources.map(({ id, name }) => ({ id, name })),
      issues: (sourceId) => {
        const notion = notionSources.find((s) => s.id === sourceId);
        if (notion) {
          // Every ticket not in the Complete group; a board with no status schema lists them all.
          const open = new Set(notionVocabulary(notion.statuses).open);
          return board.tasks
            .filter((t) => t.projectId === sourceId && t.key && (open.size === 0 || !t.status || open.has(t.status)))
            .map((t) => ({ number: t.key!, title: t.title }));
        }
        const repoId = sourceId;
        return board.tasks
          // A GitHub row carries the issue's own state ("open" / "closed") as its status (toTrackerTaskFromIssue).
          .filter((task) => task.projectId === repoId && (task.status as string) === "open" && task.number !== undefined)
          .map((task) => ({ number: task.number!, title: task.title }));
      },
      // A Notion run works in one of the window's local folders (AC-1). Its repo is the connected
      // GitHub repo whose checkout is that folder itself; sub-repos are the git folders under it (AC-2).
      workspaces: workspaceFolders()
        .filter((w) => !w.remote)
        .map(({ id, cwd }) => ({ id, path: cwd, name: cwd.split("/").filter(Boolean).pop() ?? cwd })),
      inspectWorkspace: async (path) => {
        const folder = [{ id: path, cwd: path }];
        const found = await Promise.all(
          githubSources.map(async (s) => ((await automationClient.findCheckout(s.repo, folder, null))?.cwd === path ? s : null)),
        );
        const own = found.find((s) => s !== null) ?? null;
        const subRepos = await factoryGitSubfolders(path).catch(() => []);
        // Git folders one level down make it a meta-repo, even when the folder is itself a connected
        // repo (ADR-0063): triage still picks the sub-repo, and `own` only lends its account.
        if (own) return { repo: { id: own.id, repo: own.repo, account: own.account, name: own.name }, subRepos, ...(subRepos.length > 0 ? { meta: true } : {}) };
        // A meta-repo (ADR-0063): sub-repos, no repo of its own. Triage picks the sub-repo, so the
        // run needs only a gh account; the sub-repo's is not known yet, so the first connected one.
        const first = githubSources[0];
        if (subRepos.length > 0 && first) {
          const name = path.split("/").filter(Boolean).pop() ?? path;
          return { repo: { id: "", repo: name, account: first.account, name }, subRepos, meta: true };
        }
        return { repo: null, subRepos };
      },
      presets: factoryPresets,
      // The Implement role's preset in the definition the next run reads (origin, or the private
      // one), and the branch its PRs go into.
      defaultsOf: async (repo) => {
        const checkout = await factoryCheckout(repo);
        if (!checkout) return { implementer: null, base: null };
        const view = await factoryDefinitionView(checkout, undefined, repo);
        const side = view.private ? view.local : view.origin;
        return {
          implementer: side.definition?.agents.find((a) => a.role === "implement")?.preset ?? null,
          base: view.base ? { name: view.base, fromFile: view.baseFromFile } : null,
        };
      },
      start,
    };
  }, [automationClient, board, factoryCheckout, factoryPresets, githubSources, notionSources, readNotionTicket, workspaceFolders]);
  const agents = useMemo<FactoryAgentsSource>(
    () => ({
      repos: githubSources.map(({ id, repo }) => ({ id, repo })),
      findCheckout: factoryCheckout,
      view: (checkout, repo) => factoryDefinitionView(checkout, undefined, repo),
      catalog: (checkout, base, repo) => factoryCatalog(checkout, base ?? undefined, repo),
      setupPrivate: factoryPrivateSetup,
      suggestChecks: factoryCheckSuggestions,
      checks: { preview: factoryCheckPreview, start: factoryCheckStart, status: factoryCheckStatus, cancel: factoryCheckCancel },
      saveGate: factoryGateSave,
      removePrivate: factoryPrivateRemove,
      restorePrivate: factoryPrivateRestore,
      presets: factoryPresets,
      saveAgent: factoryAgentSave,
      saveShared: factorySharedSave,
    }),
    [factoryCheckout, factoryPresets, githubSources],
  );
  return { readIssue, newRun, agents };
}
