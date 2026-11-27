import { homedir } from "node:os";
import { join } from "node:path";

import { CLAUDE_MODELS } from "../../core/claude-models.js";
import { CodexModelCatalog, type ModelOption } from "../../core/codex-models.js";
import { runnerFamily, runnerProfileId } from "../../core/runner-family.js";
import type { RunnerSummary } from "../../types/runners.js";
import { READABLE_TRANSCRIPTS } from "./transcript/tui-source.js";
import type {
  HeadlessRunner,
  RunnerModel,
  RunnerPermission,
  RunnerProfile,
  TunedRunner,
} from "./runner-shapes.js";

export type { HeadlessRunner, RunnerModel, RunnerPermission, RunnerProfile, TunedRunner } from "./runner-shapes.js";

/**
 * Every stop id this host is willing to be handed, plus the legacy pair. Built from the
 * arrays above rather than written out again, because a second hand-kept list is exactly how
 * a phone comes to offer a stop its own host then answers 400 to.
 */
export function permissionModeIds(): string[] {
  return [
    "safe",
    "yolo",
    ...CLAUDE_PERMISSIONS.map((p) => p.id),
    ...CODEX_PERMISSIONS.map((p) => p.id),
  ];
}

/**
 * What `claude --effort <level>` accepts, from `claude --help` (2026-08-27): *low, medium,
 * high, xhigh, max*. Not the desktop's `AGENT_EFFORTS`, which still lists `minimal` — the
 * CLI rejects that, and a slider stop the CLI rejects is worse than no slider.
 */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * What `-c model_reasoning_effort=…` accepts on codex-cli. `minimal` exists there and
 * not on Claude; `max` the other way round — the concrete reason the scale is per runner.
 */
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * What `claude --permission-mode <mode>` accepts, in the order they free the agent. `auto` and
 * `dontAsk` are withheld until their effect can be stated plainly. `manual` is the default (ADR-8).
 */
export const CLAUDE_PERMISSIONS: RunnerPermission[] = [
  { id: "plan", label: "plan" },
  { id: "manual", label: "manual", default: true },
  { id: "acceptEdits", label: "accept edits" },
  { id: "bypassPermissions", label: "bypass" },
];

/**
 * Codex's scale, in its own words (`/approvals`): each stop is a `--sandbox` + `--ask-for-approval`
 * pair. The defaults differ: PTY bypasses approvals (`agent-runner.ts`), structured is `on-request`
 * (`structured-sessions.ts`) and is the only one that can ask the operator.
 */
export const CODEX_PERMISSIONS: RunnerPermission[] = [
  { id: "read-only", label: "read only" },
  { id: "auto", label: "auto", defaultHeadless: true },
  { id: "full-access", label: "full access", default: true },
];

const DEFAULT_CLAUDE_MODEL = "sonnet";

/** The claude picker: aliases, with the tier the CLI would pick marked. */
function claudeTuning(): {
  models: RunnerModel[];
  efforts: string[];
  permissions: RunnerPermission[];
} {
  return {
    models: CLAUDE_MODELS.map((m) => ({
      id: m.slug,
      label: m.slug,
      ...(m.slug === DEFAULT_CLAUDE_MODEL ? { default: true } : {}),
    })),
    efforts: [...CLAUDE_EFFORTS],
    permissions: CLAUDE_PERMISSIONS,
  };
}

/**
 * Adds the tunable surface to each runner the desktop listed. A custom runner is tuned only when
 * claude-family and pinning nothing ({@link RunnerSummary.pinsTuning}); others get nothing, as
 * Lotus does not know their flags. `codexModels` is read per call (catalog is per account).
 */
export function tuneRunners(
  runners: RunnerSummary[],
  codexModels: () => ModelOption[],
  headlessRunners: readonly HeadlessRunner[] = [],
  profiles: readonly RunnerProfile[] = [],
): TunedRunner[] {
  // Only where there is a choice to make: a machine with one account needs no picker, and an
  // empty one would read as "your accounts are missing".
  const claudeProfiles = profiles.length > 1 ? { profiles: [...profiles] } : {};
  // A claude-family runner is headless when the claude bridge is here and has that account
  // (`ccs initech` is the same binary under another config dir; `core/runner-family.ts`).
  // Anything else custom stays out: Lotus does not know what a command the operator invented speaks.
  const account = new Set(profiles.map((p) => p.id));
  const familyHeadless = (runner: RunnerSummary): boolean => {
    const family = runnerFamily(runner.id);
    const profileId = runnerProfileId(runner.id);
    return family.provider !== undefined
      && profileId !== undefined
      && account.has(profileId)
      && headlessRunners.some((h) => h.id === family.provider);
  };
  // Only about runners Lotus knows. A command the operator invented may well be a claude
  // wrapper they did not mark as one, and claiming *no Chat, ever* about it would be a
  // guess — the per-cell answer (`transcriptOutlook`) stays the authority there.
  const chatOf = (runner: RunnerSummary): { chatInTerminal?: false } =>
    runner.custom || READABLE_TRANSCRIPTS.has(runner.id) ? {} : { chatInTerminal: false };
  const headlessOf = (runner: RunnerSummary): { headless?: true } =>
    (!runner.custom && headlessRunners.some((h) => h.id === runner.id)) || familyHeadless(runner)
      ? { headless: true }
      : {};
  const one = (runner: RunnerSummary): TunedRunner => {
    // The launch already fixes a model or an effort, so there is nothing to offer: the
    // phone's flag would land after the operator's own and fight it.
    if (runner.pinsTuning === true) return { ...runner, ...headlessOf(runner) };
    if (runner.custom) {
      // A claude-family wrapper carries claude's knobs, and now claude's bridge too when this
      // machine has the account behind it.
      return runner.claudeFamily
        ? { ...runner, ...claudeTuning(), ...headlessOf(runner) }
        : { ...runner };
    }
    const headless = headlessOf(runner);
    switch (runner.id) {
      case "claude":
        return { ...runner, ...claudeTuning(), ...headless, ...claudeProfiles };
      case "codex": {
        // Best-first per codex's own priority, so the first entry is what codex would
        // choose on its own (`resolveCodexModel`) — that is the `default`.
        const models = codexModels().map((m, i) => ({
          id: m.slug,
          label: shortCodexLabel(m.slug),
          ...(i === 0 ? { default: true } : {}),
        }));
        return {
          ...runner,
          // An empty catalog (no `~/.codex/models_cache.json` yet) sends no `models`
          // at all: absent means "no picker", and an empty picker would be a lie.
          ...(models.length > 0 ? { models } : {}),
          efforts: [...CODEX_EFFORTS],
          permissions: CODEX_PERMISSIONS,
          ...headless,
        };
      }
      default:
        // `cursor`, `gemini`, …: Lotus does not know their flags, so it claims none — but a
        // runner it cannot tune may still be one it can run without a terminal.
        return { ...runner, ...headless };
    }
  };
  const tuned = runners.map((runner) => ({ ...one(runner), ...chatOf(runner) }));
  // A bridge with no terminal runner behind it is still something this machine can start —
  // and until it is named here the phone cannot start it at all.
  const known = new Set(tuned.map((r) => r.id));
  return [
    ...tuned,
    ...headlessRunners
      .filter((h) => !known.has(h.id))
      .map((h) => ({
        id: h.id,
        name: h.label,
        claudeFamily: false,
        custom: false,
        pinsTuning: false,
        headless: true,
        terminal: false,
        // No terminal at all is the strongest form of "a terminal cell has no Chat".
        chatInTerminal: false as const,
      })),
  ];
}

/**
 * `gpt-5.4-codex` → `5.4-codex`: the `gpt-` prefix carries no information in a segmented
 * control. The cache's title-cased `display_name` is not used.
 */
export function shortCodexLabel(slug: string): string {
  return slug.replace(/^gpt-/, "");
}

/**
 * The catalog codex-cli keeps per ChatGPT account, read on every call: it changes with the
 * account. `list()` answers `[]` for a missing file, which `tuneRunners` turns into "no picker".
 */
export function codexModelsFromHome(): ModelOption[] {
  return new CodexModelCatalog(join(homedir(), ".codex", "models_cache.json")).list();
}
