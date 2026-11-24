import type { PtyOutputMetrics } from "@/lib/tauri-api";

export type PtyReadyReason = "agent" | "shell" | "timeout" | "gone" | "aborted";

export type PtyReadyResult = {
  reason: PtyReadyReason;
  /** Sniffed agent identity ("claude", "codex", ...) when reason==="agent". */
  agent?: string | null;
  /** Total wall-clock ms spent polling. */
  waitedMs: number;
};

export type WaitForPtyReadyOpts = {
  /** Poll interval. Default 80ms. */
  pollMs?: number;
  /** Hard ceiling. Default 8_000ms. */
  timeoutMs?: number;
  /** Idle threshold to consider a plain shell "settled". Default 400ms. */
  shellIdleMs?: number;
  /** Caller-cancellable. */
  signal?: AbortSignal;
};

type GetMetrics = (sessionId: string) => Promise<PtyOutputMetrics | null>;

const DEFAULT_POLL_MS = 80;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_SHELL_IDLE_MS = 400;

/**
 * Poll PTY metrics until one of:
 *   - Agent banner detected (`detectedAgent !== null`) → reason="agent"
 *   - Shell appears settled (`hasOutput && idleMs >= shellIdleMs`) → reason="shell"
 *   - Session vanished (metrics returns null) → reason="gone"
 *   - Hard timeout exceeded → reason="timeout"
 *   - Caller aborted → reason="aborted"
 *
 * Pure with respect to wall clock: the caller injects the metrics getter
 * (typically `getPtySessionMetrics` from tauri-api) so the function is
 * trivially testable with mocks + fake timers.
 */
export function waitForPtyReady(
  sessionId: string,
  getMetrics: GetMetrics,
  opts: WaitForPtyReadyOpts = {},
): Promise<PtyReadyResult> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const shellIdleMs = opts.shellIdleMs ?? DEFAULT_SHELL_IDLE_MS;
  const signal = opts.signal;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let aborted = false;

    function done(result: Omit<PtyReadyResult, "waitedMs">) {
      if (timer) { clearTimeout(timer); timer = null; }
      resolve({ ...result, waitedMs: Date.now() - startedAt });
    }

    function onAbort() {
      aborted = true;
      done({ reason: "aborted" });
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    async function tick() {
      if (aborted) return;
      let m: PtyOutputMetrics | null;
      try {
        m = await getMetrics(sessionId);
      } catch {
        m = null;
      }
      if (aborted) return;

      if (m === null) { done({ reason: "gone" }); return; }
      if (m.detectedAgent) { done({ reason: "agent", agent: m.detectedAgent }); return; }
      if (m.hasOutput && m.idleMs >= shellIdleMs) { done({ reason: "shell" }); return; }

      if (Date.now() - startedAt >= timeoutMs) { done({ reason: "timeout" }); return; }
      timer = setTimeout(tick, pollMs);
    }

    // Kick the first poll on the same turn so callers see deterministic behaviour
    // with fake timers (no need to advance time before the first probe).
    void tick();
  });
}
