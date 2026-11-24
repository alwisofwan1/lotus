"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { codecanvasListAllGraphRuns } from "@/lib/tauri/codecanvas";
import { onGraphRunChanged, type GraphRunChanged } from "@/lib/tauri/graph-run";
import type { GraphRunRecord } from "@/modules/codecanvas/services/graph-run-record";
import { factoryRunRows, groupFactoryRuns, needsYouCount, type FactoryRunGroup, type FactoryRunRow } from "../services/factory-run-list";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

/** What the Factory page needs from Rust; a port, so the hook is testable with no app. */
export interface FactoryRunsClient {
  listAll(): Promise<GraphRunRecord[]>;
  onChanged(handler: (event: GraphRunChanged) => void): Promise<() => void>;
}

export function createTauriFactoryRunsClient(): FactoryRunsClient {
  return { listAll: codecanvasListAllGraphRuns, onChanged: onGraphRunChanged };
}

export interface FactoryRunsHandle {
  rows: FactoryRunRow[];
  groups: FactoryRunGroup[];
  /** Runs that wait for a person: what the sidebar badge shows. */
  needsYou: number;
  loading: boolean;
  /** Why the last read failed, or why live updates are off; the rows from the read before stay. */
  error: string | null;
}

/**
 * Every Factory Run, across repos. The records are the truth: read once, then again on every
 * `graph-run://changed` — the event says "look again", it carries no state, and nothing polls.
 */
export function useFactoryRuns(client: FactoryRunsClient): FactoryRunsHandle {
  const [records, setRecords] = useState<GraphRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from read errors, so a good read does not hide that live updates are off.
  const [listenError, setListenError] = useState<string | null>(null);
  // Two reads can overlap (an event lands mid-read); only the newest one may write.
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const all = await client.listAll();
      if (mine !== latest.current) return;
      setRecords(all);
      setError(null);
    } catch (cause) {
      if (mine !== latest.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void reload();
    let unlisten: (() => void) | null = null;
    void client
      .onChanged(() => {
        if (!cancelled) void reload();
      })
      .then((stop) => {
        if (cancelled) safeTauriUnlisten(stop);
        else unlisten = stop;
      })
      .catch((cause) => {
        if (!cancelled) setListenError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      latest.current++;
      safeTauriUnlisten(unlisten);
    };
  }, [client, reload]);

  return useMemo(() => {
    const rows = factoryRunRows(records);
    return { rows, groups: groupFactoryRuns(rows), needsYou: needsYouCount(rows), loading, error: error ?? listenError };
  }, [records, loading, error, listenError]);
}
