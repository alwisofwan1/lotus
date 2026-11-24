/**
 * In-memory cache over the Runner Registry Tauri commands. The registry (~/.lotus/runners.json +
 * CLI auto-detect) changes only when the user edits it in Settings, yet the spawn hot path read it
 * fresh on every agent spawn (once in the MCP spawn bridge, again in LiveAgentNode) — two IPC
 * round-trips per spawn for data that is effectively static. Hot-path consumers read through this
 * cache; Settings mutations call `invalidate()` so the next read is fresh.
 */

import { listRunners as listRunnersUncached, getRunner as getRunnerUncached, type RunnerInfo, type RunnerRegistry } from "@/lib/tauri-api";

export interface RunnerRegistrySource {
  listRunners: () => Promise<RunnerRegistry>;
  getRunner: (id: string) => Promise<RunnerInfo | null>;
}

export interface RunnerRegistryCache {
  listRunners: () => Promise<RunnerRegistry>;
  getRunner: (id: string) => Promise<RunnerInfo | null>;
  /** Drop all cached reads — call after any runner mutation (save/delete). */
  invalidate: () => void;
}

export function createRunnerRegistryCache(source: RunnerRegistrySource): RunnerRegistryCache {
  let listPromise: Promise<RunnerRegistry> | null = null;
  const getPromises = new Map<string, Promise<RunnerInfo | null>>();

  return {
    listRunners() {
      if (listPromise) return listPromise;
      const promise = source.listRunners().then((reg) => {
        // tauri-api swallows IPC errors into { runners: [] } — don't let that transient fallback
        // (or a legit pre-hydration empty read) stick until app restart.
        if (listPromise === promise && reg.runners.length === 0) listPromise = null;
        return reg;
      });
      promise.catch(() => {
        if (listPromise === promise) listPromise = null;
      });
      listPromise = promise;
      return promise;
    },
    getRunner(id: string) {
      const cached = getPromises.get(id);
      if (cached) return cached;
      const promise = source.getRunner(id);
      getPromises.set(id, promise);
      promise.catch(() => {
        if (getPromises.get(id) === promise) getPromises.delete(id);
      });
      return promise;
    },
    invalidate() {
      listPromise = null;
      getPromises.clear();
    },
  };
}

/** Window event the Settings runner mutations dispatch — the cache's invalidation signal. */
export const RUNNERS_CHANGED_EVENT = "lotus:runners-changed";

/** Invalidate the cache whenever the runners-changed event fires on `target`. */
export function wireRunnerRegistryCacheInvalidation(cache: RunnerRegistryCache, target: EventTarget): void {
  target.addEventListener(RUNNERS_CHANGED_EVENT, () => cache.invalidate());
}

/** App-wide singleton wired to the Tauri commands + the Settings mutation signal. */
export const runnerRegistryCache = createRunnerRegistryCache({
  listRunners: listRunnersUncached,
  getRunner: getRunnerUncached,
});
if (typeof window !== "undefined") wireRunnerRegistryCacheInvalidation(runnerRegistryCache, window);
