/**
 * Whether jump labels are showing, and what has been typed at them so far.
 *
 * A store rather than component state because two unrelated things drive it: the hotkey that opens
 * it, and a window-level key listener that has to see every plain letter while it is open — and the
 * badges themselves are drawn somewhere else again. Same shape as `fleet-briefing.ts`, for the same
 * reason.
 */

import { assignJumpLabels, matchJumpLabel, type JumpLabelMatch } from "./canvas-jump-labels";

export interface JumpLabelsSnapshot {
  /** Label → node id, every label the same width. */
  labels: Map<string, string>;
  /** What has been typed at them so far. */
  typed: string;
}

export interface JumpLabelsStore {
  /** Show a badge on each of these cells, in this order. A no-op for an empty board. */
  open(nodeIds: readonly string[]): void;
  /**
   * Feed one keystroke in, and get back what it meant.
   *
   * Closes on a hit AND on a miss. A miss closes because a wrong key means the operator was not
   * aiming at a badge — staying open would swallow that keystroke and every one after it until they
   * found Escape.
   */
  typeKey(char: string): JumpLabelMatch;
  /** Put the badges away. Idempotent: Escape fires for a great many reasons. */
  cancel(): void;
  /** `null` when the badges are not showing. A fresh object per call — compare by {@link version}. */
  snapshot(): JumpLabelsSnapshot | null;
  subscribe(listener: () => void): () => void;
  version(): number;
}

export function createJumpLabelsStore(): JumpLabelsStore {
  let labels: Map<string, string> | null = null;
  let typed = "";
  let version = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    version += 1;
    listeners.forEach((listener) => listener());
  };

  const close = () => {
    if (labels === null) return false;
    labels = null;
    typed = "";
    return true;
  };

  return {
    open(nodeIds) {
      // Badges over nothing would sit there waiting for a letter that can never match.
      if (nodeIds.length === 0) return;
      labels = assignJumpLabels(nodeIds);
      typed = "";
      emit();
    },

    typeKey(char) {
      if (labels === null) return { kind: "miss" };
      const next = typed + char;
      const match = matchJumpLabel(labels, next);
      if (match.kind === "pending") {
        typed = next;
        emit();
        return match;
      }
      close();
      emit();
      return match;
    },

    cancel() {
      if (close()) emit();
    },

    snapshot() {
      return labels === null ? null : { labels: new Map(labels), typed };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    version() {
      return version;
    },
  };
}

/** Process-wide store: the hotkey, the key listener and the badges all read the same one. */
export const jumpLabelsStore: JumpLabelsStore = createJumpLabelsStore();
