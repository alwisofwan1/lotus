import type { BridgeProvider } from "../types/api.js";

/** Route on the runner family for transcript and permission handling while retaining the display label. */
export interface RunnerFamily {
  /** The family, when this host knows it. Absent for a command it cannot place. */
  provider?: BridgeProvider;
  /** The runner's own name, when it differs from its family. */
  runnerLabel?: string;
}

const CCS_PREFIX = "ccs:";

export function runnerFamily(runnerId: string): RunnerFamily {
  if (runnerId === "claude" || runnerId === "codex") return { provider: runnerId };
  // `ccs <account>` runs the claude binary with `CLAUDE_CONFIG_DIR` pointed at that account,
  // so everything downstream — the transcript format, the hooks, the permission scale — is
  // claude's. The account is what the operator reads.
  if (runnerId.startsWith(CCS_PREFIX)) {
    const account = runnerId.slice(CCS_PREFIX.length).trim();
    return account === "" ? {} : { provider: "claude", runnerLabel: account };
  }
  // A command the operator invented. Lotus does not know what it writes or how it asks, and
  // guessing `claude` here would promise a Chat page this host cannot read.
  return {};
}

/** The claude profile a runner id names, or `undefined` when it names none. */
export function runnerProfileId(runnerId: string): string | undefined {
  return runnerId.startsWith(CCS_PREFIX) ? runnerFamily(runnerId).runnerLabel : undefined;
}
