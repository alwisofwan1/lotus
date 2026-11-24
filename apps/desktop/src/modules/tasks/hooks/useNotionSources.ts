"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import {
  createTauriNotionSourceClient,
  NOTION_CAPABILITIES,
  notionVocabulary,
  toTrackerTaskFromNotionRow,
  type DataSourceSchema,
  type NotionRow,
  type NotionSourceClient,
  type NotionSourceConfig,
  type SourceSync,
} from "@/modules/tasks/services/notion-source";
import { describeHealth } from "@/modules/tasks/services/source-health";
import { TICKET_SOURCE_LABELS } from "@/modules/tasks/services/ticket-sources";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * Notion databases as ticket sources: one project each, its rows, and its health (tasks "Ticket
 * Sources 04" and "05").
 *
 * Kept fresh without a click (PLAN S24): a sync every minute while Tasks is open and the window has
 * focus, and one at once when either comes back. Each source is read in full when it appears and on
 * Refresh; in between Rust asks Notion only for what was edited, and re-reads everything every 15
 * minutes to drop trashed pages. A sync that fails keeps the last good copy on screen (PLAN S28).
 */
export interface NotionSources {
  projects: TrackerProject[];
  tasks: TrackerTask[];
  refresh: () => void;
  /** A row as Notion described it, for the page a row opens into. */
  rowOf: (projectId: string, pageId: string) => NotionRow | null;
  owns: (projectId: string) => boolean;
  /** People seen on a source's tickets — the assignee choices, since a personal token cannot list users. */
  peopleOf: (projectId: string) => { id: string; name: string }[];
  /** Labels seen on a source's tickets. */
  labelsOf: (projectId: string) => string[];
  /** A ticket as Notion answered a write, shown in the list before the next sync reads it. */
  applyRow: (projectId: string, row: NotionRow) => void;
  /** A ticket moved to trash: gone from the list at once, not at the next full read (S45). */
  removeRow: (projectId: string, pageId: string) => void;
  /** A ticket back from the trash (Undo): in the list again at once. */
  putRow: (projectId: string, row: NotionRow) => void;
  /** How many tickets on this board name `pageId` as their parent. */
  subTicketsOf: (projectId: string, pageId: string) => number;
  /** The tickets on this board that name `pageId` as their parent, in the board's order. */
  childrenOf: (projectId: string, pageId: string) => NotionRow[];
}

export interface NotionSourcesOptions {
  client?: NotionSourceClient | null;
  /** Tasks is open: poll. Closed, nothing is asked after the first read. */
  live?: boolean;
  /** How often a live source is synced. A proposal (PLAN §4), measured in CHECKPOINTS. */
  everyMs?: number;
}

/** PLAN S24's proposal. */
export const NOTION_SYNC_EVERY_MS = 60_000;

interface Read {
  syncing: boolean;
  result: SourceSync | null;
}

export function useNotionSources(
  configs: readonly NotionSourceConfig[],
  { client = null, live = false, everyMs = NOTION_SYNC_EVERY_MS }: NotionSourcesOptions = {},
): NotionSources {
  const notion = useMemo(() => client ?? createTauriNotionSourceClient(), [client]);
  const enabled = Boolean(client) || isTauri();
  const [reads, setReads] = useState<Record<string, Read>>({});
  const [now, setNow] = useState(() => Date.now());

  // Read in callbacks that must not be rebuilt whenever they change; written in effects only.
  const configsRef = useRef(configs);
  const readsRef = useRef(reads);
  const inFlight = useRef(new Set<string>());
  /*
    What this window changed in a source since its last sync began: a write's answer, a trash, an
    Undo. A sync that STARTED before such a change still carries the ticket as it was, and landing
    after it would put that back — a trashed ticket back in the list, a saved title back to the old
    one. So each change is laid over every sync result read before it; a sync that started after it
    (`syncedAtMs` is when a sync began) already has it, and the change is forgotten.
  */
  const overrides = useRef(new Map<string, Map<string, { at: number; row: NotionRow | null }>>());
  useEffect(() => {
    configsRef.current = configs;
    readsRef.current = reads;
  });

  /** Sources whose full read was asked for while a sync ran: read once it ends, with the config then. */
  const fullAfter = useRef(new Set<string>());

  const syncOne = useCallback(
    function syncOne(config: NotionSourceConfig, full: boolean) {
      // One sync per source at a time: a poll that lands while one runs has nothing to add. A full
      // read does — a new mapping, a Refresh — so it waits for that sync instead of being dropped.
      if (inFlight.current.has(config.id)) {
        if (full) fullAfter.current.add(config.id);
        return;
      }
      inFlight.current.add(config.id);
      setReads((current) => ({ ...current, [config.id]: { syncing: true, result: current[config.id]?.result ?? null } }));
      void notion
        .read(config.id, config.dataSourceId, config.mapping, { full })
        .catch((cause): SourceSync => {
          // The command itself failed — not Notion. Keep what is on screen and say so.
          const kept = readsRef.current[config.id]?.result;
          return {
            rows: kept?.rows ?? [],
            syncedAtMs: kept?.syncedAtMs ?? null,
            reconciledAtMs: kept?.reconciledAtMs ?? null,
            complete: kept?.complete ?? false,
            schema: kept?.schema ?? null,
            health: { state: "failed", message: String(cause) },
          };
        })
        .then((result) => {
          inFlight.current.delete(config.id);
          // A source removed while its sync ran is not brought back.
          const current = configsRef.current.find((c) => c.id === config.id);
          if (!current) return;
          setNow(Date.now());
          const shown = laidOver(overrides.current.get(config.id), result);
          setReads((reads) => ({ ...reads, [config.id]: { syncing: false, result: shown } }));
          if (fullAfter.current.delete(config.id)) syncOne(current, true);
        });
    },
    [notion],
  );

  /** Every source that is not waiting out a rate limit. Rust would refuse it anyway; this asks nothing. */
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

  // What a full read depends on: the database and the mapping. A rename of the source does not re-read.
  const readKey = configs.map((c) => `${c.id}|${c.dataSourceId}|${JSON.stringify(c.mapping)}`).join(" ");
  useEffect(() => {
    if (!enabled) return;
    for (const config of configsRef.current) syncOne(config, true);
  }, [enabled, readKey, syncOne]);

  // Polling: only while Tasks is open, and only while the window has focus (S24).
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

  // Notion named when it may be asked again: ask then, not at the next whole minute. And count the
  // banner's "Retrying in 30 s" down while it waits.
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
          label: TICKET_SOURCE_LABELS.notion,
          name: config.name,
          health: read?.result?.health ?? null,
          syncing: read?.syncing ?? false,
          syncedAtMs: read?.result?.syncedAtMs ?? null,
          nowMs: now,
        });
        return {
          id: config.id,
          name: config.name,
          // A Notion ticket carries its own key (`TKT-1008`), like a vault ticket.
          prefix: "",
          // The statuses as last read from Notion, so an option added there shows without a remap;
          // the ones kept with the source until a sync has read them.
          vocabulary: notionVocabulary(statusesNow(read?.result?.schema ?? null, config) ?? config.statuses),
          capabilities: NOTION_CAPABILITIES,
          source: {
            kind: "notion",
            syncLine: health.line,
            health,
            ...(config.matchNotes ? { matchesNotes: true } : {}),
          },
        };
      }),
    [configs, now, reads],
  );

  const tasks = useMemo(
    () =>
      configs.flatMap((config) =>
        (reads[config.id]?.result?.rows ?? []).map((row) => toTrackerTaskFromNotionRow(row, config.id)),
      ),
    [configs, reads],
  );

  const refresh = useCallback(() => syncDue(true), [syncDue]);
  const ids = useMemo(() => new Set(configs.map((c) => c.id)), [configs]);
  const owns = useCallback((projectId: string) => ids.has(projectId), [ids]);
  const rowOf = useCallback(
    (projectId: string, pageId: string) => reads[projectId]?.result?.rows.find((row) => row.pageId === pageId) ?? null,
    [reads],
  );

  const peopleOf = useCallback(
    (projectId: string) => {
      const people = new Map<string, string>();
      for (const row of reads[projectId]?.result?.rows ?? []) {
        row.assigneeIds.forEach((id, i) => people.set(id, row.assignees[i] ?? id));
      }
      return [...people].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    },
    [reads],
  );
  const labelsOf = useCallback(
    (projectId: string) => [...new Set((reads[projectId]?.result?.rows ?? []).flatMap((row) => row.labels))].sort(),
    [reads],
  );
  /** Records a change of this window's, and shows it at once. `row: null` = the ticket is gone. */
  const change = useCallback((projectId: string, pageId: string, row: NotionRow | null) => {
    const mine = overrides.current.get(projectId) ?? new Map();
    mine.set(pageId, { at: Date.now(), row });
    overrides.current.set(projectId, mine);
    setReads((current) => {
      const read = current[projectId];
      if (!read?.result) return current;
      return { ...current, [projectId]: { ...read, result: { ...read.result, rows: placed(read.result.rows, pageId, row) } } };
    });
  }, []);
  const applyRow = useCallback((projectId: string, row: NotionRow) => change(projectId, row.pageId, row), [change]);
  const removeRow = useCallback((projectId: string, pageId: string) => change(projectId, pageId, null), [change]);
  const putRow = applyRow;
  const childrenOf = useCallback(
    (projectId: string, pageId: string) => (reads[projectId]?.result?.rows ?? []).filter((row) => row.parents.includes(pageId)),
    [reads],
  );
  const subTicketsOf = useCallback((projectId: string, pageId: string) => childrenOf(projectId, pageId).length, [childrenOf]);

  return useMemo(
    () => ({ projects, tasks, refresh, rowOf, owns, peopleOf, labelsOf, applyRow, removeRow, putRow, subTicketsOf, childrenOf }),
    [applyRow, childrenOf, labelsOf, owns, peopleOf, projects, putRow, refresh, removeRow, rowOf, subTicketsOf, tasks],
  );
}

function statusesNow(schema: DataSourceSchema | null, config: NotionSourceConfig) {
  if (!schema || !config.mapping.status) return null;
  return schema.properties.find((p) => p.id === config.mapping.status)?.status ?? null;
}

/** `rows` with `pageId` replaced in place by `row`, added at the end when new, or taken out (`null`). */
function placed(rows: NotionRow[], pageId: string, row: NotionRow | null): NotionRow[] {
  if (!row) return rows.filter((r) => r.pageId !== pageId);
  return rows.some((r) => r.pageId === pageId) ? rows.map((r) => (r.pageId === pageId ? row : r)) : [...rows, row];
}

/** A sync result with this window's later changes laid over it; changes it already has are dropped. */
function laidOver(mine: Map<string, { at: number; row: NotionRow | null }> | undefined, result: SourceSync): SourceSync {
  if (!mine?.size) return result;
  let rows = result.rows;
  for (const [pageId, change] of mine) {
    // A failed sync hands back the kept copy with its OLD `syncedAtMs`, so it never clears a change.
    if (result.syncedAtMs !== null && result.syncedAtMs >= change.at) {
      mine.delete(pageId);
      continue;
    }
    rows = placed(rows, pageId, change.row);
  }
  return rows === result.rows ? result : { ...result, rows };
}
