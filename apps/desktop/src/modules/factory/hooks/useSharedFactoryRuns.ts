"use client";
import { useSyncExternalStore } from "react";
import type { GraphRunRecord } from "@/modules/codecanvas/services/graph-run-record";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { factoryRunRows, type FactoryRunRow } from "../services/factory-run-list";
import { factoryWorkflowId, type FactoryRef } from "../services/factory-run";
import { createTauriFactoryRunsClient, type FactoryRunsClient } from "./useFactoryRuns";

export interface FactoryRunsSnapshot {
  rows: FactoryRunRow[];
  loading: boolean;
}

/**
 * Every Factory Run, read once for everyone who looks (#146). A canvas can hold many Factory nodes;
 * each reading the whole list on each `graph-run://changed` would be one read per node per event.
 * The store reads while it has a reader, stops listening when the last one leaves, and hands each
 * reader the same rows.
 */
export interface FactoryRunsStore {
  subscribe(onChange: () => void): () => void;
  snapshot(): FactoryRunsSnapshot;
}

export function createFactoryRunsStore(client: FactoryRunsClient): FactoryRunsStore {
  let snapshot: FactoryRunsSnapshot = { rows: [], loading: true };
  const readers = new Set<() => void>();
  let stop: (() => void) | null = null;
  // Two reads can overlap (an event lands mid-read); only the newest one may write.
  let latest = 0;

  const publish = (next: FactoryRunsSnapshot) => {
    snapshot = next;
    readers.forEach((reader) => reader());
  };
  const reload = async () => {
    const mine = ++latest;
    let records: GraphRunRecord[] | null = null;
    try {
      records = await client.listAll();
    } catch {
      // The rows from the read before stay; a node is not the place to report a failed read.
    }
    if (mine !== latest) return;
    publish({ rows: records ? factoryRunRows(records) : snapshot.rows, loading: false });
  };
  const start = () => {
    let stopped = false;
    let unlisten: (() => void) | null = null;
    void reload();
    void client
      .onChanged(() => {
        if (!stopped) void reload();
      })
      .then((off) => {
        if (stopped) safeTauriUnlisten(off);
        else unlisten = off;
      })
      .catch(() => {});
    stop = () => {
      stopped = true;
      latest++;
      safeTauriUnlisten(unlisten);
    };
  };

  return {
    subscribe(onChange) {
      readers.add(onChange);
      if (readers.size === 1) start();
      return () => {
        readers.delete(onChange);
        if (readers.size === 0) {
          stop?.();
          stop = null;
        }
      };
    },
    snapshot: () => snapshot,
  };
}

let shared: FactoryRunsStore | null = null;
const sharedStore = () => (shared ??= createFactoryRunsStore(createTauriFactoryRunsClient()));
const SERVER_SNAPSHOT: FactoryRunsSnapshot = { rows: [], loading: true };

export function useSharedFactoryRuns(store?: FactoryRunsStore): FactoryRunsSnapshot {
  const s = store ?? sharedStore();
  return useSyncExternalStore(s.subscribe, s.snapshot, () => SERVER_SNAPSHOT);
}

/** One issue's newest run, live; null when it has none. */
export function useFactoryRunRow(repo: string, issue: FactoryRef, store?: FactoryRunsStore): { row: FactoryRunRow | null; loading: boolean } {
  const { rows, loading } = useSharedFactoryRuns(store);
  const key = factoryWorkflowId(repo, issue);
  return { row: rows.find((row) => factoryWorkflowId(row.repo, row.issue) === key) ?? null, loading };
}
