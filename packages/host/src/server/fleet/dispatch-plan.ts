/** Match the desktop delay because both hosts drive the same terminal UIs. */
export const SUBMIT_DELAY_MS = 120;

export interface DispatchWritePlan {
  /** In order. Two writes when a submit is wanted, one when it is not. */
  writes: string[];
  /** Pause between the body and the submit key. Zero when there is no submit. */
  delayBeforeSubmitMs: number;
  /** What the caller reports as written — the submit key counts, a stripped one does not. */
  bytes: number;
}

/** Send Enter separately after the paste so the TUI interprets it as submission. */
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
