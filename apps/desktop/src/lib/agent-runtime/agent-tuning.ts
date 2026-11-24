/**
 * What a spawn may set on a runner besides its permission posture: the model and how
 * hard it thinks. Both are process arguments, so — like the posture (`agent-gating.ts`)
 * — this is the one moment they can be chosen.
 */
import { normalizeReasoningLevel } from "./reasoning-effort";

export interface RunnerTuning {
  /** An alias the CLI resolves itself (`sonnet`, `gpt-5.4-codex`). Empty = the CLI's default. */
  model?: string;
  /** A value from the runner's own scale (`contract/README.md`, `spawn-tuning`). Empty = default. */
  effort?: string;
}

/** Runner ids whose binary is `claude`, so they take `--model` / `--effort`. */
const CLAUDE_FAMILY_PREFIXES = ["claude", "ccs", "csp"];

/**
 * The argv a runner needs to honour a tuning, as clean token pairs.
 *
 * Per family, because the flags genuinely differ: Claude Code has `--model` and
 * `--effort`; codex-cli has `-m` and takes its effort through the generic
 * `-c key=value` override of `config.toml`. A runner Lotus does not know the flags of
 * (`cursor`, `gemini`) gets nothing — the host never advertised a knob for it, so a
 * value arriving here is a client bug and is dropped rather than guessed at.
 *
 * `claudeFamily` is the Runner Registry's flag for a custom runner that is really Claude
 * behind a wrapper (`ccs <profile>`); it wins over the id prefix.
 */
export function runnerTuningArgv(
  runnerId: string,
  tuning: RunnerTuning,
  claudeFamily = false,
): string[] {
  const model = tuning.model?.trim();
  // Normalized here, at the last gate before the flag becomes argv: several surfaces still store
  // the retired "minimal" (CodeChat settings, canvas team templates), and Claude answers an
  // unknown level with a WARNING plus its own default — so a bad value looks set and is not.
  // Verified 2026-09-10: `claude --effort bogus` → "Valid values: low, medium, high, xhigh, max."
  const rawEffort = tuning.effort?.trim();
  const effort = rawEffort ? normalizeReasoningLevel(rawEffort) : undefined;
  if (!model && !effort) return [];

  const id = runnerId.trim().toLowerCase();
  if (claudeFamily || CLAUDE_FAMILY_PREFIXES.some((p) => id.startsWith(p))) {
    return [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
  }
  if (id.startsWith("codex")) {
    return [
      ...(model ? ["-m", model] : []),
      // codex reads this key from `~/.codex/config.toml`; `-c` overrides it for one run.
      // The value is TOML, hence the quotes — they are part of the argument, not shell.
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
    ];
  }
  return [];
}

/** Appends a tuning to a launch command, as `applyPermissionMode` does for the posture. */
export function applyTuning(
  command: readonly string[],
  runnerId: string,
  tuning: RunnerTuning,
  claudeFamily = false,
): string[] {
  return [...command, ...runnerTuningArgv(runnerId, tuning, claudeFamily)];
}
