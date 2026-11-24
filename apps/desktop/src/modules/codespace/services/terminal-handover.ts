import { createHandoverGate } from "@/lib/agent-runtime/tui-handover";
import { peekTerminalTranscript, tapTerminalOutput } from "./terminal-session-registry";

/**
 * Resolves true once the pane's program has taken the terminal over (`tui-handover.ts`). Reads the
 * transcript first, because the marker may already have gone by when this is called. An aborted
 * `signal` ends the wait early with false.
 */
export function awaitTerminalHandover(
  paneId: string,
  opts: { timeoutMs: number; signal?: AbortSignal; behindShell?: boolean },
): Promise<boolean> {
  const gate = createHandoverGate({ behindShell: opts.behindShell });
  gate.observe(peekTerminalTranscript(paneId));
  const untap = tapTerminalOutput(paneId, (data) => gate.observe(data));
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (opts.signal?.aborted) return resolve();
      setTimeout(resolve, ms);
    });
  return gate.wait({ timeoutMs: opts.timeoutMs, sleep }).finally(untap);
}
