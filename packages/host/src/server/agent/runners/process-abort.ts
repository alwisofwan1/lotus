import type { ChildProcess } from "node:child_process";

/**
 * Kills a spawned CLI child and rejects its run when `signal` fires (turn
 * timeout or client disconnect). Returns a detach() to call once the process
 * closes normally so the abort listener never leaks.
 */
export function attachAbort(
  proc: ChildProcess,
  signal: AbortSignal | undefined,
  reject: (err: Error) => void,
): () => void {
  if (!signal) return () => {};
  const onAbort = (): void => {
    proc.kill("SIGKILL");
    reject(new Error(typeof signal.reason === "string" ? signal.reason : "agent run aborted"));
  };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
