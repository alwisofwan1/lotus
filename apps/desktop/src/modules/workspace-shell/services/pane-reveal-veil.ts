/**
 * When a terminal pane may be shown again after focus mode changed its box.
 *
 * Focus mode on/off hands a pane a new or rebuilt renderer, and the agent inside has to repaint
 * it: a reattached pane gets a one-row resize step and back (`resizeAndRedraw`), a maximised one a
 * plain resize. Shown as it happens, that is black → half-drawn at one size → redrawn at another —
 * the "berkedip kasar" reported 2026-10-02. So the pane is veiled while that runs, and revealed
 * with a fade once the output has gone quiet.
 *
 * A pane coming BACK waits for its redraw (`awaitRedraw`). Timing alone was not enough: the
 * renderer rebuild runs before the step, so the 180 ms minimum could expire before the step even
 * went out — measured 2026-10-02, a veil lifting at exactly `covered=181ms` with the step-back
 * still to come, and a little flicker after it. Now it lifts only once the PTY is back at size
 * (`done`), the agent has had `PANE_VEIL_AFTER_REDRAW_MS` to answer, and its output is quiet.
 *
 * - `PANE_VEIL_MIN_MS`: never lift sooner than this, so the fade does not stutter.
 * - `PANE_VEIL_QUIET_MS` of no output means the repaint has landed.
 * - `PANE_VEIL_MAX_MS` caps it, so a pane that streams nonstop or never redraws is never hidden
 *   for long.
 */

export const PANE_VEIL_MIN_MS = 180;
export const PANE_VEIL_QUIET_MS = 90;
export const PANE_VEIL_AFTER_REDRAW_MS = 120;
export const PANE_VEIL_MAX_MS = 900;
/**
 * A restart (account move) relaunches the agent: measured 2026-11-16, `claude --resume` printed
 * nothing for 1.2 s, then replayed with gaps up to 0.8 s and settled at ~2.9 s.
 */
export const PANE_VEIL_RESTART_QUIET_MS = 1000;
export const PANE_VEIL_RESTART_MAX_MS = 8000;
/**
 * A freshly launched pane: veiled until its agent's first output has gone quiet. Shorter than a
 * restart on purpose; a pane that is still drawing at 3 s is better shown than hidden.
 */
export const PANE_VEIL_BOOT_QUIET_MS = 300;
export const PANE_VEIL_BOOT_MAX_MS = 3000;

export interface PaneRevealVeilStart {
  /** Hold the veil until a redraw has gone `pending` → `done` (or the cap). */
  awaitRedraw?: boolean;
  /** Hold the veil until the first output (a relaunched agent prints nothing at first). */
  awaitOutput?: boolean;
  quietMs?: number;
  maxMs?: number;
}

export interface PaneRevealVeil {
  /** Veil now; `onReveal` fires once the repaint has settled. Restarts if already veiled. */
  start(options?: PaneRevealVeilStart): void;
  /** Output arrived for this pane. */
  noteOutput(): void;
  /** The pane's PTY redraw step went out (`pending`) or completed (`done`). */
  noteRedraw(phase: "pending" | "done"): void;
  dispose(): void;
}

export function createPaneRevealVeil(
  onReveal: () => void,
  now: () => number = () => performance.now(),
): PaneRevealVeil {
  let startedAt: number | null = null;
  let lastOutputAt = 0;
  let awaitingRedraw = false;
  let awaitingOutput = false;
  let quietMs = PANE_VEIL_QUIET_MS;
  let redrawDoneAt: number | null = null;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (checkTimer !== null) clearTimeout(checkTimer);
    if (capTimer !== null) clearTimeout(capTimer);
    checkTimer = null;
    capTimer = null;
  };

  const reveal = () => {
    if (startedAt === null) return;
    clear();
    startedAt = null;
    onReveal();
  };

  /** How long until the pane may be revealed; null while a redraw is still awaited. */
  const remaining = (t: number): number | null => {
    if (startedAt === null || awaitingRedraw || awaitingOutput) return null;
    return Math.max(
      startedAt + PANE_VEIL_MIN_MS - t,
      lastOutputAt + quietMs - t,
      redrawDoneAt === null ? 0 : redrawDoneAt + PANE_VEIL_AFTER_REDRAW_MS - t,
      0,
    );
  };

  const scheduleCheck = () => {
    if (checkTimer !== null) clearTimeout(checkTimer);
    checkTimer = null;
    const wait = remaining(now());
    if (wait === null) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      if (remaining(now()) === 0) reveal();
      else scheduleCheck();
    }, wait);
  };

  return {
    start(options = {}) {
      clear();
      startedAt = now();
      lastOutputAt = startedAt;
      awaitingRedraw = options.awaitRedraw ?? false;
      awaitingOutput = options.awaitOutput ?? false;
      quietMs = options.quietMs ?? PANE_VEIL_QUIET_MS;
      redrawDoneAt = null;
      capTimer = setTimeout(reveal, options.maxMs ?? PANE_VEIL_MAX_MS);
      scheduleCheck();
    },
    noteOutput() {
      if (startedAt === null) return;
      lastOutputAt = now();
      if (awaitingOutput) {
        awaitingOutput = false;
        scheduleCheck();
      }
    },
    noteRedraw(phase) {
      if (startedAt === null) return;
      if (phase === "pending") {
        awaitingRedraw = true;
        redrawDoneAt = null;
        scheduleCheck();
        return;
      }
      awaitingRedraw = false;
      redrawDoneAt = now();
      lastOutputAt = redrawDoneAt;
      scheduleCheck();
    },
    dispose() {
      clear();
      startedAt = null;
    },
  };
}
