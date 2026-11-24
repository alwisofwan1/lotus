"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import {
  createTauriGitHubIssuesClient,
  GITHUB_CAPABILITIES,
  GITHUB_ISSUE_VOCABULARY,
  toTrackerTaskFromIssue,
  type GitHubIssue,
  type GitHubIssuesClient,
  type GitHubSourceConfig,
  type IssueSourceSync,
} from "@/modules/tasks/services/github-issues-source";
import { describeHealth } from "@/modules/tasks/services/source-health";
import { TICKET_SOURCE_LABELS } from "@/modules/tasks/services/ticket-sources";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * GitHub repos as ticket sources: one project each, its issues, and its health (ADR-0048, PLAN G12).
 *
 * The same rhythm as Notion's (`useNotionSources`): a sync every minute while Tasks is open and the
 * window has focus, and one at once when focus comes back. Each source is read in full when it
 * appears and on Refresh; in between Rust asks GitHub only for what changed, and re-reads everything
 * every 15 minutes. A sync that fails keeps the last good copy on screen. Read only, so there is no
 * write to lay over a sync — unlike Notion's hook.
 */
export interface GitHubIssueSources {
  projects: TrackerProject[];
  tasks: TrackerTask[];
  refresh: () => void;
  owns: (projectId: string) => boolean;
  /** An issue as the last sync read it, for the panel a row opens into. */
  issueOf: (projectId: string, number: number) => GitHubIssue | null;
}

export interface GitHubIssueSourcesOptions {
  client?: GitHubIssuesClient | null;
  /** Tasks is open: poll. Closed, nothing is asked after the first read. */
  live?: boolean;
  everyMs?: number;
}

/** PLAN G12, the same as Notion's. */
export const GITHUB_SYNC_EVERY_MS = 60_000;

interface Read {
  syncing: boolean;
  result: IssueSourceSync | null;
}

export function useGitHubIssueSources(
  configs: readonly GitHubSourceConfig[],
  { client = null, live = false, everyMs = GITHUB_SYNC_EVERY_MS }: GitHubIssueSourcesOptions = {},
): GitHubIssueSources {
  const github = useMemo(() => client ?? createTauriGitHubIssuesClient(), [client]);
  const enabled = Boolean(client) || isTauri();
  const [reads, setReads] = useState<Record<string, Read>>({});
  const [now, setNow] = useState(() => Date.now());

  const configsRef = useRef(configs);
  const readsRef = useRef(reads);
  const inFlight = useRef(new Set<string>());
  /** Sources whose full read was asked for while a sync ran: read once it ends. */
  const fullAfter = useRef(new Set<string>());
  useEffect(() => {
    configsRef.current = configs;
    readsRef.current = reads;
  });

  const syncOne = useCallback(
    function syncOne(config: GitHubSourceConfig, full: boolean) {
      // One sync per source at a time. A big repo's full read takes seconds (cli/cli: ~18 s), and a
      // poll landing meanwhile has nothing to add; a Refresh does, so it waits instead.
      if (inFlight.current.has(config.id)) {
        if (full) fullAfter.current.add(config.id);
        return;
      }
      inFlight.current.add(config.id);
      setReads((current) => ({ ...current, [config.id]: { syncing: true, result: current[config.id]?.result ?? null } }));
      void github
        .sync(config.id, { full })
        .catch((cause): IssueSourceSync => {
          // The command itself failed — not GitHub. Keep what is on screen and say so.
          const kept = readsRef.current[config.id]?.result;
          return {
            issues: kept?.issues ?? [],
            syncedAtMs: kept?.syncedAtMs ?? null,
            reconciledAtMs: kept?.reconciledAtMs ?? null,
            format: kept?.format ?? 0,
            health: { state: "failed", message: String(cause) },
          };
        })
        .then((result) => {
          inFlight.current.delete(config.id);
          // A source removed while its sync ran is not brought back.
          const current = configsRef.current.find((c) => c.id === config.id);
          if (!current) return;
          setNow(Date.now());
          setReads((reads) => ({ ...reads, [config.id]: { syncing: false, result } }));
          if (fullAfter.current.delete(config.id)) syncOne(current, true);
        });
    },
    [github],
  );

  /** Every source that is not waiting out a rate limit. Rust would ask nothing anyway. */
  const syncDue = useCallback(
    (full: boolean) => {
      const at = Date.now();
      for (const config of configsRef.current) {
        const health = readsRef.current[config.id]?.result?.health;
        if (health?.state === "slowed_down" && at < health.retryAtMs) continue;
        syncOne(config, full);
      }
    },
    [syncOne],
  );

  // What a full read depends on. Rust reads the account and repo from settings, so they are part of
  // the key too: a source pointed at another repo is read again at once.
  const readKey = configs.map((c) => `${c.id}|${c.account}|${c.repo}`).join(" ");
  useEffect(() => {
    if (!enabled) return;
    for (const config of configsRef.current) syncOne(config, true);
  }, [enabled, readKey, syncOne]);

  // Polling: only while Tasks is open, and only while the window has focus (PLAN G12).
  useEffect(() => {
    if (!enabled || !live) return;
    const focused = () => document.hasFocus() && document.visibilityState !== "hidden";
    if (focused()) syncDue(false);
    const timer = setInterval(() => {
      if (focused()) syncDue(false);
    }, everyMs);
    const onFocus = () => syncDue(false);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, everyMs, live, syncDue]);

  // A rate limit names when to ask again: ask then, and count the banner's wait down meanwhile.
  const retryAt = useMemo(() => {
    const times = Object.values(reads).flatMap((read) =>
      read.result?.health.state === "slowed_down" ? [read.result.health.retryAtMs] : [],
    );
    return times.length ? Math.min(...times) : null;
  }, [reads]);
  useEffect(() => {
    if (!enabled || !live || retryAt === null) return;
    const retry = setTimeout(() => syncDue(false), Math.max(0, retryAt - Date.now()));
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearTimeout(retry);
      clearInterval(tick);
    };
  }, [enabled, live, retryAt, syncDue]);

  const projects = useMemo(
    () =>
      configs.map<TrackerProject>((config) => {
        const read = reads[config.id];
        const health = describeHealth({
          label: TICKET_SOURCE_LABELS.github,
          name: config.name,
          health: read?.result?.health ?? null,
          syncing: read?.syncing ?? false,
          syncedAtMs: read?.result?.syncedAtMs ?? null,
          nowMs: now,
        });
        return {
          id: config.id,
          name: config.name,
          // An issue is `#123`; the key comes from its number, not a prefix (`trackerTaskKey`).
          prefix: "",
          vocabulary: GITHUB_ISSUE_VOCABULARY,
          capabilities: GITHUB_CAPABILITIES,
          source: { kind: "github", syncLine: health.line, health },
        };
      }),
    [configs, now, reads],
  );

  const tasks = useMemo(
    () =>
      configs.flatMap((config) =>
        (reads[config.id]?.result?.issues ?? []).map((issue) => toTrackerTaskFromIssue(issue, config.id)),
      ),
    [configs, reads],
  );

  const refresh = useCallback(() => syncDue(true), [syncDue]);
  const ids = useMemo(() => new Set(configs.map((c) => c.id)), [configs]);
  const owns = useCallback((projectId: string) => ids.has(projectId), [ids]);
  const issueOf = useCallback(
    (projectId: string, number: number) => reads[projectId]?.result?.issues.find((issue) => issue.number === number) ?? null,
    [reads],
  );

  return useMemo(() => ({ projects, tasks, refresh, owns, issueOf }), [issueOf, owns, projects, refresh, tasks]);
}
