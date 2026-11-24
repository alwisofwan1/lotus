/**
 * How long to wait between the body and the Enter that submits it.
 *
 * The desktop's own number (`build_dispatch_write_plan`, `mcp_ipc.rs`), kept identical
 * rather than re-derived: the same TUIs are on the other end of both, and a second guess
 * would only be a second thing to keep in sync.
 */
export const SUBMIT_DELAY_MS = 120;

export interface DispatchWritePlan {
  /** In order. Two writes when a submit is wanted, one when it is not. */
  writes: string[];
  /** Pause between the body and the submit key. Zero when there is no submit. */
  delayBeforeSubmitMs: number;
  /** What the caller reports as written — the submit key counts, a stripped one does not. */
  bytes: number;
}

/**
 * Splits a dispatch into the writes a terminal UI will actually act on.
 *
 * A TUI swallows a paste that carries its own Enter — measured on the desktop 2026-08-06,
 * and again on a VPS 2026-09-05 when a phone's "Hi" sat unsent in Codex's composer while
 * the `\n` that came with it did nothing. Sending the Enter as its own write, a beat later,
 * is what makes it read as a keypress instead of as part of the paste.
 *
 * Every PTY cell on a standalone host is a TUI target, so unlike the desktop there is
 * nothing to decide here: a structured cell never reaches this path (`structured.dispatch`
 * answers first), and a plain shell is unharmed by receiving its Enter separately.
 */
export function dispatchWritePlan(command: string, appendNewline: boolean): DispatchWritePlan {
  if (!appendNewline) {
    return { writes: [command], delayBeforeSubmitMs: 0, bytes: Buffer.byteLength(command, "utf8") };
  }
  // CR, not LF: this is the Enter key, and a TUI reads the key rather than the character.
  const submit = "\r";
  const body = command.replace(/\r?\n$|\r$/, "");
  return {
    writes: [body, submit],
    delayBeforeSubmitMs: SUBMIT_DELAY_MS,
    bytes: Buffer.byteLength(body, "utf8") + submit.length,
  };
}
