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
 * What `claude --permission-mode <mode>` accepts, from `claude --help` (2026-08-27), in
 * the order they free the agent: *plan* may change nothing, *manual* asks per action,
 * *acceptEdits* writes on its own, *bypassPermissions* asks nothing.
 *
 * **The CLI lists six and this offers four.** `auto` and `dontAsk` are real values on that
 * build and are deliberately withheld: nobody here has measured what either does, and a
 * stop whose consequence cannot be written in one honest sentence is worse than a stop that
 * is missing. Adding them later is this array plus a label — no client changes, which is
 * the point of advertising the scale rather than hardcoding it.
 *
 * `manual` is the default because it is what `claude` already does with no flag at all, and
 * because a gated cell asks by raising `needs-input` — which the phone is standing by to
 * answer (ADR-8).
 */
export const CLAUDE_PERMISSIONS: RunnerPermission[] = [
  { id: "plan", label: "plan" },
  { id: "manual", label: "manual", default: true },
  { id: "acceptEdits", label: "accept edits" },
  { id: "bypassPermissions", label: "bypass" },
];

/**
 * Codex's scale, in Codex's own words (`/approvals`), because it is not Claude's scale
 * wearing different labels: there is no `--permission-mode` on `codex` at all. Each stop
 * here is a *pair* — `--sandbox` and `--ask-for-approval` — collapsed to the one word the
 * CLI's own picker uses, and expanded again by whichever spawn path runs it.
 *
 * **The two defaults differ, and that is a fact about this repo rather than a preference.**
 * A PTY Codex has been launched `--dangerously-bypass-approvals-and-sandbox` since long
 * before the phone existed (`agent-runner.ts`), while a structured one is started
 * `approvalPolicy: "on-request"` (`structured-sessions.ts`) — and only the structured one
 * can put its approval in front of the operator, because it has no terminal to ask into.
 * Marking both keeps each path exactly where it already was on the day this scale arrived.
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
 * Adds the tunable surface to each runner the desktop listed.
 *
 * **A custom runner is tuned when — and only when — it is claude-family and pins nothing.**
 * This used to refuse every custom runner, on the stated grounds that its command already
 * carries `--model`. That is true of `ccs acme --model opus` and false of
 * `ccs initech --dangerously-skip-permissions`, and the second is the common shape: a
 * second-account Claude wrapper. The desktop appends `--model`/`--effort` to exactly those
 * runners (`live-agent-spawn.ts`, "the phone's summon sheet"), so refusing them withheld a
 * picker the machine would have honoured — while the operator watched their own agent spawn
 * on whatever the CLI defaulted to. What the assumption was reaching for is now a fact the
 * registry sends: {@link RunnerSummary.pinsTuning}.
 *
 * A custom runner that is *not* claude-family still gets nothing, and for the original
 * reason: Lotus does not know the flags of a command the operator invented (`opencode`,
 * `grok`), so it claims none.
 *
 * `codexModels` is read per call, not once: the catalog is a file codex-cli refreshes
 * per account, and a phone that paired yesterday should see today's list.
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
  // A claude-family runner **is** headless when the claude bridge is here and this machine has
  // that account: `ccs initech` is the same binary under another config dir, so the bridge
  // runs it with `profileId` and the cell gets the streaming Chat and the structured
  // permission a native claude cell gets (`core/runner-family.ts`).
  //
  // Anything else custom stays out, and for the original reason: Lotus does not know what a
  // command the operator invented speaks.
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
 * `gpt-5.4-codex` → `5.4-codex`, `gpt-5.4` → `5.4`. The `gpt-` prefix is the same on
 * every row of a four-way segmented control, so it carries no information there. The
 * cache's `display_name` is deliberately *not* used: it is title-cased marketing copy
 * (`GPT-5.4 Codex`) and the control is set in lowercase serif like every other label.
 */
export function shortCodexLabel(slug: string): string {
  return slug.replace(/^gpt-/, "");
}

/**
 * The catalog codex-cli keeps per ChatGPT account, read on every call rather than once
 * at start: the file does not exist on a machine that has not run codex yet, and it
 * changes when the account does. `list()` answers `[]` for a missing file, which
 * `tuneRunners` turns into "no picker" rather than an empty one.
 */
export function codexModelsFromHome(): ModelOption[] {
  return new CodexModelCatalog(join(homedir(), ".codex", "models_cache.json")).list();
}
