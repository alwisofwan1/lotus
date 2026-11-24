/**
 * What a machine can launch.
 *
 * Its own file rather than a section of `fleet.ts`: a fleet member is an agent that
 * **is running**, and a runner is the thing that could start one. The two are read by
 * different callers at different moments, and keeping them together pushed that file
 * past the 300-line limit the moment the phone needed this list.
 */

/**
 * One runner this machine can actually launch.
 *
 * Native CLIs and user-defined custom runners arrive in one list, because a client that
 * only wants to start something cannot act on the difference. What it can act on is
 * {@link RunnerSummary.claudeFamily}: only those runners have a permission gate that
 * can be asked for at spawn (ADR-8), and only at spawn.
 */
export interface RunnerSummary {
  /** The id a spawn names — `claude`, or `custom-acme`. */
  id: string;
  /** What the operator calls it: `Pi`, `acme`. Never the command. */
  name: string;
  /** Whether it runs the `claude` binary, so Lotus' hooks fire and it can be gated. */
  claudeFamily: boolean;
  custom: boolean;
  /**
   * Whether this runner's own launch command already fixes a model or an effort.
   *
   * Optional because a desktop older than the field cannot say, and **absent must read as
   * `false`**: the two runners this has always been asked about — `claude` and `codex` —
   * carry no such flag on a default install, and treating silence as "pinned" would take
   * the summon sheet's knobs away from every host that has not shipped yet.
   *
   * It exists because {@link tuneRunners} used to answer the question by *assuming*: every
   * custom runner was treated as one that owns its flags. True of `ccs acme --model opus`,
   * false of `ccs initech --dangerously-skip-permissions`, and the second is the common
   * shape — so a claude-family wrapper was denied a picker its machine would have honoured.
   */
  pinsTuning?: boolean;
}

export interface ListRunnersResponse {
  items: RunnerSummary[];
}
