/**
 * Phase 0 latency instrumentation for the NL / voice command pipeline. The 5–10s "spawn → agent" lag
 * is suspected to be cold `claude --print` spawns per utility call (parse / refine / polish) plus
 * agent boot — but we measure before optimizing. A trace records per-stage deltas + total; the command
 * bar logs `summary()` to the console so the real hotspot is visible on the actual machine.
 *
 * The clock is injected so the tracer is unit-testable; the runtime passes `performance.now`.
 */
export interface LatencyTrace {
  /** Record the elapsed time since the previous mark (or start) under `label`. */
  mark(label: string): void;
  /** `[nl-latency] parse=320ms refine=2100ms total=2425ms` — for console / dev HUD. */
  summary(): string;
  /** The single slowest recorded stage, or null if none — quick triage. */
  slowest(): { label: string; ms: number } | null;
}

export function createLatencyTrace(now: () => number = () => performance.now()): LatencyTrace {
  const start = now();
  let last = start;
  const stages: { label: string; ms: number }[] = [];
  return {
    mark(label) {
      const t = now();
      stages.push({ label, ms: Math.round(t - last) });
      last = t;
    },
    summary() {
      const parts = stages.map((s) => `${s.label}=${s.ms}ms`);
      parts.push(`total=${Math.round(now() - start)}ms`);
      return `[nl-latency] ${parts.join(" ")}`;
    },
    slowest() {
      return stages.reduce<{ label: string; ms: number } | null>(
        (max, s) => (max === null || s.ms > max.ms ? s : max),
        null,
      );
    },
  };
}
