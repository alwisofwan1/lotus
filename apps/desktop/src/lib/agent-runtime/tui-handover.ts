/**
 * Two primitives for talking to a terminal that has not finished starting up.
 *
 * Both were measured, not reasoned about — see `packages/host/src/server/agent/tui-prompt.ts`
 * (2026-09-07), whose numbers these mirror. This module is the browser-side twin: the host version
 * pulls bytes with `tail()`, while a Lotus pane is pushed its bytes by `onOutput`, so the readiness
 * check has to accumulate instead of poll.
 *
 * 1. **Wait for the handover.** Bytes written while the terminal is still being reconfigured are
 *    consumed and lost. The signal is the terminal announcing itself — bracketed paste (`?2004h`),
 *    which a zsh line editor arms before drawing its prompt, or the alt screen (`?1049h`) a
 *    full-screen TUI switches to. Both appear in
 *    `src-tauri/src/permission_prompt_fixtures/live-stream-80x24.bin`, the shell's before the typed
 *    command and the TUI's after it. Prose on screen is not used: it changes with every release.
 * 2. **Text and Enter are separate writes, and Enter repeats.** A single burst carrying a newline
 *    is taken as pasted text and left sitting in the input box. Enter on an empty box is a no-op,
 *    so repeating it costs nothing and rescues a runner that was still settling on the first press.
 */

/**
 * Bracketed-paste and alt-screen toggles. An `h` is the handover: a line editor or full-screen TUI
 * taking the terminal. `?2004l` is what a line editor emits
 * when it accepts a command line and hands the terminal to the program it runs (the fixture above:
 * `?2004h` at the prompt, `?2004l` after `claude …` is typed, then the agent's own `?1049h`).
 */
const TERMINAL_TOGGLE = /\x1b\[\?(1049|2004)([hl])/g;

/** Enough tail to still match a marker that straddled two output chunks. */
const CARRY_BYTES = 64;

export interface HandoverGateOptions {
  /**
   * A shell runs first and the agent is typed into it. The shell's own prompt arms bracketed paste
   * too, so a marker only counts once the shell has handed the terminal over (`?2004l`). Without
   * this, text meant for the agent lands on the shell's command line and runs as a command.
   */
  behindShell?: boolean;
}

export interface HandoverWaitOptions {
  /** Past this the gate reports closed and the caller must not type. */
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HandoverGate {
  /** Feed every output chunk the pane receives. Cheap: only the last bytes are kept. */
  observe(chunk: string): void;
  readonly ready: boolean;
  /** Resolves true once the marker has been seen, false if the timeout passed without one. */
  wait(options?: HandoverWaitOptions): Promise<boolean>;
}

export function createHandoverGate(options: HandoverGateOptions = {}): HandoverGate {
  let ready = false;
  let shellHandedOver = !options.behindShell;
  // Only the boundary is kept, because a marker can arrive split across two chunks and an escape
  // sequence is short. Keeping the whole transcript to answer a yes/no question would be waste.
  let carry = "";

  return {
    observe(chunk: string): void {
      if (ready || !chunk) return;
      const window = carry + chunk;
      let consumed = 0;
      for (const match of window.matchAll(TERMINAL_TOGGLE)) {
        consumed = match.index + match[0].length;
        if (match[2] === "l") {
          if (match[1] === "2004") shellHandedOver = true;
        } else if (shellHandedOver) {
          ready = true;
          carry = "";
          return;
        }
      }
      // Never carry a marker already acted on: re-reading a shell's `?2004l` is harmless, but a
      // re-read `h` would be counted twice.
      carry = window.slice(Math.max(consumed, window.length - CARRY_BYTES));
    },
    get ready(): boolean {
      return ready;
    },
    async wait(options: HandoverWaitOptions = {}): Promise<boolean> {
      const timeout = options.timeoutMs ?? 20_000;
      const poll = options.pollMs ?? 150;
      const sleep = options.sleep ?? defaultSleep;
      const attempts = Math.max(1, Math.ceil(timeout / poll));
      for (let i = 0; i < attempts; i++) {
        if (ready) return true;
        await sleep(poll);
      }
      return ready;
    },
  };
}

export interface SubmitKeystrokeOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Between the handover and the first keystroke: the terminal is still drawing. */
  settleMs?: number;
  /** Between the text and Enter, so the two are separate keystrokes. */
  enterMs?: number;
  /** How many Enters to press, spaced further apart each time. */
  enterAttempts?: number;
}

/**
 * Types `text` as text, then presses Enter as its own write, repeatedly. The caller is responsible
 * for the terminal being ready — pair this with {@link createHandoverGate}.
 *
 * `write` may be async (a Tauri `writeToSession` returns a Promise): it is awaited, so a PTY that
 * has gone away rejects here instead of being reported as a successful submit.
 */
export async function submitAsKeystrokes(
  write: (data: string) => void | Promise<void>,
  text: string,
  options: SubmitKeystrokeOptions = {},
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const gap = options.enterMs ?? 150;
  await sleep(options.settleMs ?? 250);
  await write(text);
  for (let attempt = 0; attempt < (options.enterAttempts ?? 3); attempt++) {
    // gap * 1, then * 4, then * 7 — 150ms, 600ms, 1050ms at the default gap. Each wait is longer
    // than the last, so a terminal that was busy on the first press has had time to finish by the
    // next. (The prose in `tui-prompt.ts` says 1350 for the third; its own formula gives 1050.
    // The behaviour, not the comment, is what was measured working.)
    await sleep(gap * (attempt * 3 + 1));
    await write("\r");
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });
