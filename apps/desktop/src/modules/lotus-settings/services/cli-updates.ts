/**
 * Agent CLI updates, shared by Settings › Updates and the title-bar pill (plans/app-updates).
 *
 * One module-level store so both surfaces see the same run: closing Settings mid-update must not
 * lose its log, and the pill keeps spinning. Rust owns the rules (`src-tauri/src/cli_updates.rs`);
 * this file only fetches, runs one update at a time, and remembers the outcome per CLI.
 */
import { useSyncExternalStore } from "react";
import { isTauri, loadTauriCore, tauriInvoke } from "@/lib/tauri/runtime";

export type CliUpdateState = "up-to-date" | "update-available" | "latest-unknown" | "update-manually";

export interface CliUpdateStatus {
  id: string;
  name: string;
  path: string;
  current: string | null;
  latest: string | null;
  state: CliUpdateState;
  updater: string | null;
  command: string | null;
  canRun: boolean;
}

type CliUpdateEvent =
  | { type: "output"; line: string }
  | { type: "done"; ok: boolean; version: string | null; message: string | null };

export interface CliRunResult {
  ok: boolean;
  version: string | null;
  message: string | null;
}

export interface CliUpdatesSnapshot {
  items: CliUpdateStatus[] | null;
  checking: boolean;
  checkedAt: number | null;
  error: string | null;
  running: string | null;
  logs: Record<string, string[]>;
  results: Record<string, CliRunResult>;
}

const LOG_CAP = 200;
/** How often a long-running window re-checks; npm view is cheap, but not free. */
export const RECHECK_MS = 6 * 60 * 60 * 1000;

let snapshot: CliUpdatesSnapshot = { items: null, checking: false, checkedAt: null, error: null, running: null, logs: {}, results: {} };
const listeners = new Set<() => void>();

function set(patch: Partial<CliUpdatesSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}

export function useCliUpdates(): CliUpdatesSnapshot {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** A row Lotus can act on with one click. */
export function isActionable(item: CliUpdateStatus): boolean {
  return item.canRun && item.state === "update-available";
}

let inflight: Promise<void> | null = null;

/** Joins a check already in flight; after an update that is not enough, see `runCliUpdate`. */
export function checkCliUpdates(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  inflight ??= (async () => {
    set({ checking: true, error: null });
    try {
      const items = await tauriInvoke<CliUpdateStatus[]>("cli_update_status", {});
      set({ items, checking: false, checkedAt: Date.now() });
    } catch (err) {
      set({ checking: false, error: String(err) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Check unless a check landed within `maxAgeMs`. */
export function checkCliUpdatesIfStale(maxAgeMs = RECHECK_MS): void {
  if (snapshot.checkedAt === null || Date.now() - snapshot.checkedAt >= maxAgeMs) void checkCliUpdates();
}

export async function runCliUpdate(id: string): Promise<CliRunResult> {
  if (snapshot.running) return { ok: false, version: null, message: "Another update is running." };
  const { [id]: _drop, ...results } = snapshot.results;
  set({ running: id, logs: { ...snapshot.logs, [id]: [] }, results });
  let result: CliRunResult = { ok: false, version: null, message: "The updater stopped without a result." };
  try {
    const { invoke, Channel } = await loadTauriCore();
    const channel = new Channel<CliUpdateEvent>();
    channel.onmessage = (event) => {
      if (event.type === "output") {
        const log = [...(snapshot.logs[id] ?? []), event.line].slice(-LOG_CAP);
        set({ logs: { ...snapshot.logs, [id]: log } });
      } else {
        result = { ok: event.ok, version: event.version, message: event.message };
      }
    };
    await invoke("cli_update_run", { id, onEvent: channel });
  } catch (err) {
    result = { ok: false, version: null, message: String(err) };
  }
  set({ running: null, results: { ...snapshot.results, [id]: result } });
  // A check that began during the run read the old version: let it land, then read again.
  await inflight;
  await checkCliUpdates();
  return result;
}

/** One after another: the Rust side allows a single run at a time. */
export async function runAllCliUpdates(): Promise<void> {
  for (const item of (snapshot.items ?? []).filter(isActionable)) {
    await runCliUpdate(item.id);
  }
}

/** Test seam. */
export function resetCliUpdatesForTest(next: Partial<CliUpdatesSnapshot> = {}): void {
  snapshot = { items: null, checking: false, checkedAt: null, error: null, running: null, logs: {}, results: {}, ...next };
  listeners.forEach((l) => l());
}
