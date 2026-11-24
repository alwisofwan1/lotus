/**
 * Serialized PTY submit queue — paste text into a TUI runner, then send Enter after a settle
 * delay so bracketed-paste registers a real submit. Submissions are strictly serialized: a new
 * submit while an Enter is pending is queued and pasted only AFTER that Enter fires, so two
 * rapid dispatches each land as their own turn (fixes the shared-Enter-timer race where the
 * second dispatch cancelled the first one's Enter).
 */

export interface PtySubmitQueueOptions {
  /** Write raw bytes to the PTY (paste text / Enter), optionally awaiting native acknowledgement. */
  write: (data: string) => Promise<void> | void;
  /** Delay between pasting the text and sending Enter. */
  enterDelayMs: number;
}

export interface PtySubmitQueue {
  /** Paste + submit one message; resolves only after its Enter byte is written. */
  submit: (text: string) => Promise<void>;
  /** Cancel pending Enter + queued messages (node unmount). */
  dispose: () => void;
}

interface PendingSubmit {
  text: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

const SUBMIT_DISPOSED_ERROR = "PTY submit was cancelled before Enter was written.";

export function createPtySubmitQueue({ write, enterDelayMs }: PtySubmitQueueOptions): PtySubmitQueue {
  const pending: PendingSubmit[] = [];
  let active: PendingSubmit | null = null;
  let enterTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const toError = (error: unknown, fallback: string) =>
    error instanceof Error ? error : new Error(fallback);

  const advance = (submission: PendingSubmit, error?: Error) => {
    if (active !== submission) return;
    active = null;
    if (error) submission.reject(error);
    else submission.resolve();
    const next = pending.shift();
    if (next !== undefined) paste(next);
  };

  const writeEnter = (submission: PendingSubmit) => {
    if (active !== submission) return;
    enterTimer = null;
    try {
      const acknowledgement = write("\r");
      if (acknowledgement && typeof acknowledgement.then === "function") {
        acknowledgement.then(
          () => advance(submission),
          (error) => advance(submission, toError(error, "PTY Enter write failed.")),
        );
      } else {
        advance(submission);
      }
    } catch (error) {
      advance(submission, toError(error, "PTY Enter write failed."));
    }
  };

  const scheduleEnter = (submission: PendingSubmit) => {
    if (active !== submission) return;
    enterTimer = setTimeout(() => writeEnter(submission), enterDelayMs);
  };

  function paste(submission: PendingSubmit) {
    active = submission;
    try {
      const acknowledgement = write(submission.text);
      if (acknowledgement && typeof acknowledgement.then === "function") {
        acknowledgement.then(
          () => scheduleEnter(submission),
          (error) => advance(submission, toError(error, "PTY write failed.")),
        );
      } else {
        scheduleEnter(submission);
      }
    } catch (error) {
      advance(submission, toError(error, "PTY write failed."));
    }
  }

  return {
    submit(text: string) {
      if (disposed) return Promise.reject(new Error(SUBMIT_DISPOSED_ERROR));
      return new Promise<void>((resolve, reject) => {
        const submission = { text, resolve, reject };
        if (active !== null) pending.push(submission);
        else paste(submission);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (enterTimer !== null) clearTimeout(enterTimer);
      enterTimer = null;
      const error = new Error(SUBMIT_DISPOSED_ERROR);
      active?.reject(error);
      active = null;
      pending.splice(0).forEach((submission) => submission.reject(error));
    },
  };
}
