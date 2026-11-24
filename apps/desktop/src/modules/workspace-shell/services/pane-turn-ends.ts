import {
  paneTurnRegistry,
  type PaneTurnRegistry,
} from "@/modules/codecanvas/services/pane-turn-registry";

/**
 * When a pane's agent has finished a turn — the question the "Selesai · baru" mark answers.
 *
 * **This decides nothing new.** It is CodeCanvas's turn-end policy (`useAgentDoneCallouts`, ADR-0031),
 * lifted out of its React hook so the shell can ask the same question about its own panes. The
 * rules, and the incidents behind them, are that hook's:
 *
 *  1. **The Stop hook is authoritative.** `mcp://agent-stopped` fires once per finished response,
 *     keyed by `LOTUS_PANE_ID` — which for a shell pane is its cell id, so no correlation is needed.
 *  2. **A PTY settle is only a backstop**, for runners with no hook (cursor, custom) or whose hook
 *     is dead. It counts only inside a turn a SUBMIT opened: repaints, resizes and keystroke echo
 *     settle too, and they are what used to produce "done" with nothing done.
 *  3. **One turn is reported once.** `claimAnnouncement` admits the first of the two signals and
 *     denies the other, whichever order they land in.
 *  4. **A pane whose hook has ever spoken never falls back.** Its settles are not believed again.
 *     "Ever" has to outlive this object: seen live 2026-09-24, two Claude panes with a working hook
 *     lit up from a settle ~30s after a hot reload, because the coverage set was remembered only
 *     here and the remount forgot it. `hookHasReported` asks the durable record instead.
 *
 * `turns` defaults to the process-wide registry CodeCanvas already feeds. The two surfaces never
 * hold the same pane id, so sharing it costs nothing and keeps one turn window per pane in the app.
 */
export interface PaneTurnEnds {
  /** Every chunk written into the pane; a submit opens a turn. */
  noteInput(paneId: string, data: string): void;
  /** Output from the pane keeps an open turn alive; it never opens one. */
  noteOutput(paneId: string): void;
  /** Is a turn a submit opened still open on this pane? Read BEFORE `hookStopped` claims it. */
  isTurnOpen(paneId: string): boolean;
  /** The Stop hook fired. True when this is a turn end not yet reported. */
  hookStopped(paneId: string): boolean;
  /** The PTY went from busy to quiet. True only when that is a real, unreported turn end. */
  settled(paneId: string): boolean;
  /** The pane is gone. */
  forget(paneId: string): void;
}

export interface PaneTurnEndsOptions {
  turns?: PaneTurnRegistry;
  /**
   * Has this pane's hook EVER reported, as a record that survives a remount? The shell passes the
   * hook-fact registry, which Rust cold-hydrates on mount. Absent = only what this object heard.
   */
  hookHasReported?: (paneId: string) => boolean;
}

export function createPaneTurnEnds({
  turns = paneTurnRegistry,
  hookHasReported = () => false,
}: PaneTurnEndsOptions = {}): PaneTurnEnds {
  const hookCovered = new Set<string>();

  return {
    noteInput(paneId, data) {
      turns.noteInput(paneId, data);
    },
    noteOutput(paneId) {
      turns.noteActivity(paneId);
    },
    isTurnOpen(paneId) {
      return turns.isTurnOpen(paneId);
    },
    hookStopped(paneId) {
      hookCovered.add(paneId);
      // Left OPEN after the claim, as CodeCanvas does: a settle from the same turn is then denied by
      // the claim rather than read as a second turn.
      return turns.claimAnnouncement(paneId);
    },
    settled(paneId) {
      if (hookCovered.has(paneId) || hookHasReported(paneId)) return false;
      if (!turns.isTurnOpen(paneId)) return false;
      return turns.claimAnnouncement(paneId);
    },
    forget(paneId) {
      hookCovered.delete(paneId);
      turns.clear(paneId);
    },
  };
}
