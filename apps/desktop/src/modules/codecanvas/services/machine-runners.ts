import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { RemoteCapabilityProfile } from "@/lib/tauri/codespace-editor-ssh";

/**
 * Which runners a machine can actually start, and why the others cannot be offered.
 *
 * **This exists because of a real spawn.** On 2026-09-15 an agent node was started on `devbox-vps`
 * and the machine answered `zsh:1: command not found: claude`. The runner menu had offered a CLI
 * that was not there, and the only place that said so was a dead pane. A menu that offers what the
 * machine cannot run is a menu that lies; this turns the probe's answer into what the menu shows.
 */

/** The executable each canvas runner actually invokes on PATH. */
const RUNNER_EXECUTABLE: Record<Exclude<AgentRunnerType, "custom">, string> = {
  claude: "claude",
  ccs: "ccs",
  csp: "csp",
  codex: "codex",
  cursor: "cursor-agent",
};

export interface RunnerAvailability {
  runner: AgentRunnerType;
  /** The executable looked for on the machine. */
  executable: string;
  available: boolean;
  /** Version the machine reported, when it gave one. */
  version?: string;
  /** Present when it cannot be offered — written for an operator, not a log. */
  reason?: string;
}

/**
 * Judge each runner against a machine's probe.
 *
 * **A missing profile is not "unavailable".** Until the probe answers we know nothing, and a menu
 * that greys everything out on a machine we simply have not asked yet is worse than one that offers
 * too much: the operator cannot tell "not installed" from "not asked". So `null` means every runner
 * stays offered, exactly as a local project behaves.
 */
export function runnerAvailability(
  runners: readonly AgentRunnerType[],
  profile: RemoteCapabilityProfile | null | undefined,
  machineLabel = "mesin ini",
): RunnerAvailability[] {
  return runners.map((runner) => {
    // A custom runner is an arbitrary command the operator typed; we have no executable to look for
    // and must not pretend to have checked it.
    if (runner === "custom") {
      return { runner, executable: "", available: true };
    }
    const executable = RUNNER_EXECUTABLE[runner];
    if (!profile) {
      return { runner, executable, available: true };
    }
    const found = profile.runners?.find((entry) => entry.id === executable);
    if (!found) {
      return {
        runner,
        executable,
        available: false,
        reason: `Tidak ada di PATH ${machineLabel}`,
      };
    }
    return {
      runner,
      executable,
      available: true,
      ...(found.version ? { version: found.version } : {}),
    };
  });
}

/**
 * The runners worth offering first — those the machine has.
 *
 * Kept separate from {@link runnerAvailability} because a menu still has to *show* the unavailable
 * ones with their reason; hiding them sends an operator hunting for a runner they know they
 * installed, which is the same mistake the machine picker refuses to make with git-only aliases.
 */
export function availableRunners(
  availability: readonly RunnerAvailability[],
): AgentRunnerType[] {
  return availability.filter((entry) => entry.available).map((entry) => entry.runner);
}

/** Whether the probe found nothing at all — a machine that cannot start any agent. */
export function hasNoRunners(availability: readonly RunnerAvailability[]): boolean {
  return availability.length > 0 && availability.every((entry) => !entry.available);
}

/** The executable a detected CLI would actually invoke — the first token of its command. */
export function cliExecutable(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

/**
 * Keep only the CLIs a machine can actually start.
 *
 * Applied to the ⌘K Launch rows, which are otherwise built from the CLIs installed **on this
 * desktop** — the wrong machine entirely once the active project lives somewhere else. That is how
 * an agent came to be launched against a `claude` the VPS did not have.
 *
 * As everywhere else here, an unprobed machine keeps every row: not-yet-asked must never render as
 * not-installed.
 */
export function clisOnMachine<T extends { command: string }>(
  clis: readonly T[],
  profile: RemoteCapabilityProfile | null | undefined,
): T[] {
  if (!profile?.runners) return [...clis];
  const present = new Set(profile.runners.map((runner) => runner.id));
  return clis.filter((cli) => present.has(cliExecutable(cli.command)));
}
