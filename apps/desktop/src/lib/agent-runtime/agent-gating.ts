import type { AgentRunnerType } from "@/lib/agent-runtime/agent-runner";

/**
 * Whether a cell will ask before acting, and if not, why not.
 *
 * `skipped` and `runner_cannot` look identical from the outside and have
 * different fixes: a Claude cell launched with the gate off can be respawned in
 * safe mode, a Codex cell can never gate because it has no hook mechanism
 * (ADR-8). Collapsing them would tell the operator to do something impossible.
 */
export type AgentGating = "asks" | "skipped" | "runner_cannot";

/** Runners that execute the `claude` binary, so Lotus' hooks fire for them. */
const HOOK_CAPABLE: ReadonlySet<AgentRunnerType> = new Set(["claude", "ccs", "csp"]);

/** Runners with no hook mechanism at all. */
const HOOKLESS: ReadonlySet<AgentRunnerType> = new Set(["codex", "cursor"]);

/** Flags that turn the gate off, one per runner family. */
const SKIP_FLAGS = [
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
];

/** Whether a cell should be born asking, or born running. */
export type PermissionMode = "safe" | "yolo";

/**
 * Which flag turns a runner's gate off, keyed by the prefix its id starts with.
 *
 * Prefixes rather than exact ids on purpose: this is asked with two different
 * vocabularies — `AgentRunnerType` (`claude`, `ccs`, `csp`, …) on the canvas and
 * `ProviderId` (`claude`, `ccs-hss`, `claude-headless`, …) in CodeSpace — and a table
 * keyed by one of them would silently return "no flag" for the other, which reads as
 * *this runner cannot be un-gated* rather than as *nobody told me about it*.
 */
const SKIP_FLAG_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["claude", "--dangerously-skip-permissions"],
  ["ccs", "--dangerously-skip-permissions"],
  ["csp", "--dangerously-skip-permissions"],
  ["codex", "--dangerously-bypass-approvals-and-sandbox"],
  ["gemini", "--yolo"],
];

/**
 * Rewrites a launch command so the cell is born in the asked-for mode.
 *
 * **This is the only moment the choice exists.** `--dangerously-skip-permissions` is a
 * process argument, so a cell already running cannot be turned back — which is why
 * ADR-8 accepts that the phone's dispatch has no brake, and why a spawn that carries a
 * mode is the one place a brake can be fitted at all.
 *
 * `safe` strips any skip flag the base command carried rather than merely not adding
 * one: the caller asked for a cell that asks, and a preset that already opted out would
 * otherwise silently win.
 *
 * A runner with no flag of its own is returned untouched. That is not a failure to
 * honour the request — `deriveGating` will still report `runner_cannot`, and the UI
 * that offered the choice is expected not to offer it there.
 */
export function applyPermissionMode(
  command: readonly string[],
  runner: string,
  mode: PermissionMode,
): string[] {
  const stripped = command.filter((arg) => !SKIP_FLAGS.includes(arg));
  if (mode === "safe") return stripped;

  const id = runner.trim().toLowerCase();
  const found = SKIP_FLAG_BY_PREFIX.find(([prefix]) => id.startsWith(prefix));
  return found ? [...stripped, found[1]] : stripped;
}

/**
 * Derives gating from the command that actually launched the cell.
 *
 * Reading the real command is deliberate: a parallel `permissionMode` field could
 * drift from what ran, while the command is the thing that ran. Returns
 * `undefined` when the answer is genuinely unknown rather than guessing, because
 * absent must read as *unknown* in the UI, never as *ungated*.
 */
export function deriveGating(
  runner: AgentRunnerType,
  launchCommand: string | undefined,
): AgentGating | undefined {
  if (HOOKLESS.has(runner)) return "runner_cannot";
  if (!HOOK_CAPABLE.has(runner)) return undefined;
  if (launchCommand === undefined || launchCommand.trim().length === 0) return undefined;

  return SKIP_FLAGS.some((flag) => launchCommand.includes(flag)) ? "skipped" : "asks";
}
