import {
  KITTY_SHIFT_ENTER_SEQUENCE,
  META_ENTER_SEQUENCE,
} from "@/modules/codespace/services/terminal-keybindings";

/**
 * Per-pane "turn window" tracker (agent-done notify RCA, P0 turn-gating).
 *
 * The byte-idle fallback used to treat ANY PTY output as agent work — terminal repaints
 * (resize/reattach/focus), keystroke echo and TUI ticks all read as a "turn" and produced false
 * "agent is done" callouts. This registry records the only honest signal that a turn actually
 * started: a submit (Enter) written INTO the pane. The idle watcher may then only announce panes
 * whose turn window is open, and closes the window when it fires.
 */

export interface PaneTurnRegistry {
  /** Feed every chunk written to the pane's PTY; a submit-bearing chunk opens the turn window. */
  noteInput(paneId: string, data: string): void;
  /** Refresh an existing turn from real PTY output; never opens a turn on its own. */
  noteActivity(paneId: string): void;
  isTurnOpen(paneId: string): boolean;
  /**
   * Atomically claim the single spoken callout for the pane's CURRENT open turn. Returns `true` the
   * first time it is called for a given open turn (and records it), `false` for any later call about
   * that SAME turn — so whichever finish signal (stop-hook or idle) arrives first wins and the other
   * is denied, regardless of the frequency throttle (cooldown=0 / freshTurn bypass it, but never this).
   * When no turn is open (headless / autonomous finishes) it defers with `true` — those channels have
   * their own one-shot/throttle guards and must not be silenced here. Does NOT close the window.
   */
  claimAnnouncement(paneId: string): boolean;
  /** Close after announcing (or on turn-end from an authoritative signal). */
  closeTurn(paneId: string): void;
  /** Drop all state for a pane (node closed/unmounted). */
  clear(paneId: string): void;
}

/** Bracketed-paste envelope: everything between ESC[200~ and ESC[201~ is pasted CONTENT — its
 *  newlines land in the TUI composer without submitting. Evaluated per write-chunk, which matches
 *  how pastes reach the PTY here (planLiveAgentPaste emits the whole envelope in one write). */
const BRACKETED_PASTE_RE = /\x1b\[200~[\s\S]*?\x1b\[201~/g;

/** The chords that INSERT a newline rather than submitting — Shift+Enter, per runner family.
 *
 *  `META_ENTER_SEQUENCE` is ESC + CR, so a chunk carrying it looks exactly like a submit to a naive
 *  CR test. Every non-Claude-family runner uses it (`live-agent-newline.ts`), which meant composing
 *  a multi-line prompt on a codex/cursor/custom pane counted as answering the agent: the caller
 *  clears `needs-you` on any input this predicate accepts, so the badge vanished mid-sentence while
 *  the agent was still blocked — and a blocked agent emits nothing that could raise it again.
 *
 *  Removed rather than used to veto the chunk, because a submit-queue write can legitimately carry
 *  a composed newline AND the closing Enter together. */
const NEWLINE_INSERT_SEQUENCES = [KITTY_SHIFT_ENTER_SEQUENCE, META_ENTER_SEQUENCE] as const;

/** True when a PTY input chunk represents a submit (Enter) rather than plain typing/paste. */
export function inputOpensTurn(data: string): boolean {
  const outsidePaste = data.replace(BRACKETED_PASTE_RE, "");
  const outsideCompose = NEWLINE_INSERT_SEQUENCES.reduce(
    (text, sequence) => text.split(sequence).join(""),
    outsidePaste,
  );
  return outsideCompose.includes("\r") || outsideCompose.includes("\n");
}

/** How long an opened turn stays announceable without an authoritative close. Long agent turns
 *  keep re-marking activity via output, but a submit that led nowhere must not leave the pane
 *  armed forever — a repaint hours later would read as "done". */
export const TURN_OPEN_TTL_MS = 20 * 60_000;

export function createPaneTurnRegistry(now: () => number = Date.now): PaneTurnRegistry {
  const openedAt = new Map<string, number>();
  // Monotonic per-open turn id — the dedup identity. A counter (not the timestamp) so two submits in
  // the same millisecond are still distinct turns.
  const turnId = new Map<string, number>();
  // The turn id whose callout has already been spoken.
  const announcedTurn = new Map<string, number>();
  let seq = 0;

  const isOpen = (paneId: string): boolean => {
    const at = openedAt.get(paneId);
    if (at === undefined) return false;
    if (now() - at > TURN_OPEN_TTL_MS) {
      openedAt.delete(paneId);
      turnId.delete(paneId);
      return false;
    }
    return true;
  };

  return {
    noteInput(paneId, data) {
      if (inputOpensTurn(data)) {
        openedAt.set(paneId, now());
        turnId.set(paneId, ++seq);
      }
    },
    noteActivity(paneId) {
      if (isOpen(paneId)) openedAt.set(paneId, now());
    },
    isTurnOpen: isOpen,
    claimAnnouncement(paneId) {
      // No open turn (or expired) → nothing to dedupe; defer to the caller's own guard.
      if (!isOpen(paneId)) return true;
      const id = turnId.get(paneId)!;
      if (announcedTurn.get(paneId) === id) return false; // this exact turn already announced
      announcedTurn.set(paneId, id);
      return true;
    },
    closeTurn(paneId) {
      openedAt.delete(paneId);
      turnId.delete(paneId);
      announcedTurn.delete(paneId);
    },
    clear(paneId) {
      openedAt.delete(paneId);
      turnId.delete(paneId);
      announcedTurn.delete(paneId);
    },
  };
}

/** Process-wide registry shared by LiveAgentNode (producer) and the callout hook (consumer). */
export const paneTurnRegistry: PaneTurnRegistry = createPaneTurnRegistry();
