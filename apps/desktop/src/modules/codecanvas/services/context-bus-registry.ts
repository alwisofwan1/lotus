import type { ContextArtifact } from "./context-bus-record";

export type ContextBusListener = (artifacts: ContextArtifact[]) => void;

/** Shared empty array so `list` returns a stable reference for an unknown bus (safe for useSyncExternalStore). */
const EMPTY: ContextArtifact[] = [];

export interface ContextBusRegistry {
  /** Insert or overwrite the artifact for its (busNodeId, key). */
  publish(artifact: ContextArtifact): void;
  /** Artifacts on one bus, in insertion order. Stable reference until the bus changes. */
  list(busNodeId: string): ContextArtifact[];
  /** The current artifact for one (bus, key), if any. */
  get(busNodeId: string, key: string): ContextArtifact | undefined;
  /** Replace the whole registry from a durable source (canvas load). */
  hydrate(artifacts: ContextArtifact[]): void;
  /** Drop buses whose node is gone (node removal / project switch). */
  prune(keepBusIds: Iterable<string>): void;
  subscribe(busNodeId: string, listener: ContextBusListener): () => void;
}

/**
 * The live, synchronous read surface of the Context Bus — a per-bus list of named
 * artifacts. Agents read it at run time (getContext is synchronous) and Context Nodes
 * subscribe to render it. Each bus holds a stable array reference (rebuilt only on
 * change) so it is safe for useSyncExternalStore. Durability lives in
 * `context-bus-store.ts`, which hydrates this registry on load and is written through
 * on publish. Mirrors `canvas-attachment-store.ts`.
 */
export function createContextBusRegistry(): ContextBusRegistry {
  const buses = new Map<string, ContextArtifact[]>();
  const listeners = new Map<string, Set<ContextBusListener>>();

  const emit = (busNodeId: string) => {
    const list = buses.get(busNodeId) ?? EMPTY;
    listeners.get(busNodeId)?.forEach((listener) => listener(list));
  };
  // Upsert by key, preserving order: replace an existing slot in place, else append. New array → stable until next change.
  const put = (artifact: ContextArtifact) => {
    const current = buses.get(artifact.busNodeId) ?? [];
    const index = current.findIndex((a) => a.key === artifact.key);
    const next = index >= 0
      ? current.map((a, i) => (i === index ? artifact : a))
      : [...current, artifact];
    buses.set(artifact.busNodeId, next);
  };

  return {
    publish(artifact) {
      put(artifact);
      emit(artifact.busNodeId);
    },
    list(busNodeId) {
      return buses.get(busNodeId) ?? EMPTY;
    },
    get(busNodeId, key) {
      return buses.get(busNodeId)?.find((a) => a.key === key);
    },
    hydrate(artifacts) {
      const changed = new Set([...buses.keys()]);
      buses.clear();
      for (const artifact of artifacts) { put(artifact); changed.add(artifact.busNodeId); }
      for (const busNodeId of changed) emit(busNodeId);
    },
    prune(keepBusIds) {
      const keep = new Set(keepBusIds);
      for (const busNodeId of [...buses.keys()]) {
        if (!keep.has(busNodeId)) {
          buses.delete(busNodeId);
          emit(busNodeId);
        }
      }
    },
    subscribe(busNodeId, listener) {
      const set = listeners.get(busNodeId) ?? new Set<ContextBusListener>();
      set.add(listener);
      listeners.set(busNodeId, set);
      return () => { set.delete(listener); };
    },
  };
}

/** Process-wide context bus — agents write, Context Nodes & downstream agents read. */
export const contextBusRegistry: ContextBusRegistry = createContextBusRegistry();
