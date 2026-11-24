import { isTauri } from "@/lib/tauri/runtime";
import {
  codecanvasSaveGraphRun,
  codecanvasListGraphRuns,
  codecanvasGetGraphRun,
} from "@/lib/tauri/codecanvas";
import {
  deriveGraphRunStatus,
  type GraphRunCheckpoint,
  type GraphRunRecord,
  type GraphRunStatus,
} from "./graph-run-record";

export const MAX_RUNS_PER_PROJECT = 20;

export interface GraphRunStore {
  create(record: GraphRunRecord): Promise<void>;
  /** Persists a new checkpoint; status (and endedAt) are derived from it. */
  update(id: string, checkpoint: GraphRunCheckpoint, now: number): Promise<void>;
  /** Forces a terminal status (e.g. user cancellation). */
  finalize(id: string, status: GraphRunStatus, now: number): Promise<void>;
  /** Marks a run stopped at its budget cap: resumable, so it keeps no end time. */
  pause(id: string, now: number): Promise<void>;
  /** Runs for a project, newest first. */
  list(projectId: string): Promise<GraphRunRecord[]>;
  get(id: string): Promise<GraphRunRecord | null>;
}

/** Persistence primitives; the read-modify-write status logic is shared above. */
interface GraphRunIO {
  upsert(record: GraphRunRecord): Promise<void>;
  list(projectId: string): Promise<GraphRunRecord[]>;
  get(id: string): Promise<GraphRunRecord | null>;
}

function createGraphRunStore(io: GraphRunIO): GraphRunStore {
  return {
    create: (record) => io.upsert(record),
    list: (projectId) => io.list(projectId),
    get: (id) => io.get(id),
    async update(id, checkpoint, now) {
      const rec = await io.get(id);
      if (!rec) return;
      const status = deriveGraphRunStatus(checkpoint);
      await io.upsert({
        ...rec,
        checkpoint,
        status,
        endedAt: status === "running" ? null : now,
        updatedAt: now,
      });
    },
    async finalize(id, status, now) {
      const rec = await io.get(id);
      if (!rec) return;
      await io.upsert({ ...rec, status, endedAt: now, updatedAt: now });
    },
    async pause(id, now) {
      const rec = await io.get(id);
      if (!rec) return;
      await io.upsert({ ...rec, status: "paused", endedAt: null, updatedAt: now });
    },
  };
}

export function createInMemoryGraphRunStore(): GraphRunStore {
  const byId = new Map<string, GraphRunRecord>();
  return createGraphRunStore({
    async upsert(record) {
      byId.set(record.id, record);
      const projectRuns = [...byId.values()]
        .filter((r) => r.projectId === record.projectId)
        .sort((a, b) => b.startedAt - a.startedAt);
      for (const stale of projectRuns.slice(MAX_RUNS_PER_PROJECT)) byId.delete(stale.id);
    },
    async list(projectId) {
      return [...byId.values()]
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => b.startedAt - a.startedAt);
    },
    async get(id) {
      return byId.get(id) ?? null;
    },
  });
}

export function createTauriGraphRunStore(): GraphRunStore {
  return createGraphRunStore({
    upsert: (record) => codecanvasSaveGraphRun(record),
    list: (projectId) => codecanvasListGraphRuns(projectId),
    get: (id) => codecanvasGetGraphRun(id),
  });
}

/** Process-wide graph-run store — SQLite in the desktop app, volatile in browser/tests. */
export const graphRunStore: GraphRunStore = isTauri()
  ? createTauriGraphRunStore()
  : createInMemoryGraphRunStore();
