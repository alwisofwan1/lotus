import type { CanvasImageRef } from "./canvas-intake";

export type CanvasAttachmentListener = (refs: CanvasImageRef[]) => void;

/** Shared empty array so `list` returns a stable reference (safe for useSyncExternalStore). */
const EMPTY: CanvasImageRef[] = [];

/**
 * Session-scoped attachments held per Canvas Node id. Like the Canvas Skills Node,
 * it is never written to the Canvas Snapshot — it resets on reload.
 */
export class CanvasAttachmentStore {
  private byNode = new Map<string, CanvasImageRef[]>();
  private listeners = new Map<string, Set<CanvasAttachmentListener>>();

  list(nodeId: string): CanvasImageRef[] {
    return this.byNode.get(nodeId) ?? EMPTY;
  }

  add(nodeId: string, refs: CanvasImageRef[]): void {
    if (refs.length === 0) return;
    this.byNode.set(nodeId, [...this.list(nodeId), ...refs]);
    this.emit(nodeId);
  }

  removeAt(nodeId: string, index: number): void {
    const current = this.list(nodeId);
    if (index < 0 || index >= current.length) return;
    this.byNode.set(nodeId, current.filter((_, i) => i !== index));
    this.emit(nodeId);
  }

  clear(nodeId: string): void {
    if (!this.byNode.has(nodeId)) return;
    this.byNode.delete(nodeId);
    this.emit(nodeId);
  }

  /** Drop attachments for any node no longer present (called on node removal/reload). */
  prune(keepIds: Iterable<string>): void {
    const keep = new Set(keepIds);
    for (const id of [...this.byNode.keys()]) {
      if (!keep.has(id)) this.clear(id);
    }
  }

  subscribe(nodeId: string, listener: CanvasAttachmentListener): () => void {
    const set = this.listeners.get(nodeId) ?? new Set<CanvasAttachmentListener>();
    set.add(listener);
    this.listeners.set(nodeId, set);
    return () => { set.delete(listener); };
  }

  private emit(nodeId: string): void {
    this.listeners.get(nodeId)?.forEach((listener) => listener(this.list(nodeId)));
  }
}

/** App-level singleton — intake writes, Agent Node reads at run time. */
export const canvasAttachmentStore = new CanvasAttachmentStore();
