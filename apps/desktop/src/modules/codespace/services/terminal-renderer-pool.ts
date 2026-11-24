/**
 * Terminal Renderer Pool — caps live xterm canvas / WebGL instances.
 *
 * Every live Terminal allocates a canvas element and (optionally) a WebGL
 * context.  With N workspaces × M panes that's N×M live canvases regardless
 * of visibility.  The pool enforces a hard cap of MAX_POOL_SLOTS live
 * terminals: when a new terminal is registered past the limit the
 * lowest-scored *retained* pane is serialized with SerializeAddon and
 * evicted — its terminal is disposed and its output continues to flow into
 * the DormantRing until it rehydrates on next reveal.
 *
 * Eviction scoring (Terax pattern):
 *   visible   +1000  — never evict what the user can see
 *   alt-screen +100  — TUI app would lose its state
 *   agent-busy  +80  — Claude / Codex is actively writing
 *   focused     +10  — pane the user last clicked
 *   recency tiebreak (newer = slightly harder to evict)
 *
 * Legacy fallback usage in useLegacyTerminalRuntime:
 *
 *   // After terminal + addons are ready:
 *   rendererPool.register(paneId, term, addons, onEvict);
 *   const snap = rendererPool.claimSnapshot(paneId);
 *   if (snap) term.write(snap);        // rehydrate from previous eviction
 *
 *   // On visibility / activity changes:
 *   rendererPool.updateSignals(paneId, { isVisible: active, agentActive });
 *
 *   // In useEffect cleanup:
 *   rendererPool.unregister(paneId);
 */

import type { Terminal } from "@xterm/xterm";
import type { TerminalAddons } from "./terminal-addons";

// ── Public types ────────────────────────────────────────────────────────────

export interface PoolPaneSignals {
  isVisible: boolean;
  agentActive: boolean;
  isFocused: boolean;
  isAltScreen: boolean;
}

/** Called when the pool forcibly evicts a pane to free a slot. */
export type PoolEvictCallback = (snapshot: string | null) => void;

// ── Internal ────────────────────────────────────────────────────────────────

interface PoolEntry {
  readonly paneId: string;
  readonly term: Terminal;
  readonly addons: TerminalAddons;
  onEvict: PoolEvictCallback;
  signals: PoolPaneSignals;
  /** Wall-clock ms at registration time — recency tiebreak. */
  readonly registeredAt: number;
}

const DEFAULT_SIGNALS: PoolPaneSignals = {
  isVisible: false,
  agentActive: false,
  isFocused: false,
  isAltScreen: false,
};

/** Higher score = harder to evict. */
function scoreEntry(e: PoolEntry): number {
  const s = e.signals;
  return (
    (s.isVisible   ? 1000 : 0) +
    (s.isAltScreen ?  100 : 0) +
    (s.agentActive ?   80 : 0) +
    (s.isFocused   ?   10 : 0) +
    // Recency tiebreak: normalise registeredAt to a 0–1 range over ~1 hour.
    Math.min(e.registeredAt / 3_600_000, 1)
  );
}

/**
 * Serialize the terminal's visible viewport + scrollback (up to 5000 lines).
 * Loads SerializeAddon lazily — not all evictions will need serialization.
 */
async function serializeTerminal(term: Terminal): Promise<string | null> {
  try {
    const { SerializeAddon } = await import("@xterm/addon-serialize");
    const addon = new SerializeAddon();
    term.loadAddon(addon);
    const snapshot = addon.serialize({ scrollback: 5000 });
    addon.dispose();
    return snapshot || null;
  } catch {
    return null;
  }
}

// ── Pool class ───────────────────────────────────────────────────────────────

/**
 * Maximum number of live Terminal instances allowed at once.
 * Sized to cover a 6-pane grid layout (2×3) with 2 headroom slots.
 */
export const MAX_POOL_SLOTS = 8;

class TerminalRendererPool {
  private readonly entries = new Map<string, PoolEntry>();
  /** Snapshots from evicted panes, keyed by paneId. Claimed on re-creation. */
  private readonly snapshots = new Map<string, string>();

  /**
   * Register a newly-created Terminal instance for `paneId`.
   *
   * If the pool is already at capacity, the lowest-scored registered pane is
   * evicted asynchronously (serialisation → dispose → onEvict callback).
   *
   * `onEvict` is called when the pool takes back this pane's slot.  The
   * callback should null-out any refs pointing at `term`/`addons`, dispose
   * them, and let the pane continue in DormantRing / `ready_hidden` mode.
   */
  register(
    paneId: string,
    term: Terminal,
    addons: TerminalAddons,
    onEvict: PoolEvictCallback,
  ): void {
    // Replace stale registration (pane re-created without an explicit unregister).
    this.entries.delete(paneId);

    if (this.entries.size >= MAX_POOL_SLOTS) {
      this.evictLowestScored();
    }

    this.entries.set(paneId, {
      paneId,
      term,
      addons,
      onEvict,
      signals: { ...DEFAULT_SIGNALS },
      registeredAt: Date.now(),
    });
  }

  /**
   * Deregister a pane's terminal (called in useEffect cleanup when the pane
   * unmounts or its key deps change).  Does NOT evict: the caller is already
   * responsible for disposal via the normal cleanup path.
   */
  unregister(paneId: string): void {
    this.entries.delete(paneId);
  }

  /** Update eviction-priority signals for `paneId`. */
  updateSignals(paneId: string, signals: Partial<PoolPaneSignals>): void {
    const entry = this.entries.get(paneId);
    if (!entry) return;
    entry.signals = { ...entry.signals, ...signals };
  }

  /**
   * Claim and consume the stored snapshot for `paneId`.
   *
   * Returns the serialised terminal string if the pane was previously evicted,
   * or `null` if no snapshot exists.  The snapshot is removed after the call —
   * write it into the fresh terminal immediately after terminal construction.
   */
  claimSnapshot(paneId: string): string | null {
    const snapshot = this.snapshots.get(paneId) ?? null;
    this.snapshots.delete(paneId);
    return snapshot;
  }

  /** Non-consuming peek — useful to decide whether to restore before addons load. */
  hasSnapshot(paneId: string): boolean {
    return this.snapshots.has(paneId);
  }

  /** Current number of registered live terminals. */
  get size(): number {
    return this.entries.size;
  }

  private evictLowestScored(): void {
    if (this.entries.size === 0) return;

    let lowestScore = Infinity;
    let victim: PoolEntry | null = null;

    for (const entry of this.entries.values()) {
      const s = scoreEntry(entry);
      if (s < lowestScore) {
        lowestScore = s;
        victim = entry;
      }
    }

    if (!victim) return;
    this.entries.delete(victim.paneId);

    // Serialise asynchronously so the main thread isn't blocked.
    const { paneId, term, onEvict } = victim;
    void serializeTerminal(term).then((snapshot) => {
      if (snapshot) this.snapshots.set(paneId, snapshot);
      // The evict callback disposes `term` and `addons` and nulls the pane's
      // termRef so subsequent output flows into the DormantRing instead.
      onEvict(snapshot);
    });
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────

export const rendererPool = new TerminalRendererPool();
