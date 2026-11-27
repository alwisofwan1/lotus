
/** Merge launchable runners into one list while retaining the permission capability needed at spawn (ADR-8). */
export interface RunnerSummary {
  /** The id a spawn names — `claude`, or `custom-acme`. */
  id: string;
  /** What the operator calls it: `Pi`, `acme`. Never the command. */
  name: string;
  /** Whether it runs the `claude` binary, so Lotus' hooks fire and it can be gated. */
  claudeFamily: boolean;
  custom: boolean;
  /** Treat missing pinsTuning as false so older hosts still offer model and effort controls. */
  pinsTuning?: boolean;
}

export interface ListRunnersResponse {
  items: RunnerSummary[];
}
