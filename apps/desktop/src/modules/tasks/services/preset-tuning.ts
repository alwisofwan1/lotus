import { MODEL_CATALOG, type ModelProvider } from "@/config/models";
import {
  normalizeReasoningLevel,
  REASONING_LEVELS,
  type ReasoningLevel,
} from "@/lib/agent-runtime/reasoning-effort";
import { CLAUDE_EFFORTS, CODEX_EFFORTS_XHIGH } from "@/config/models/catalog";

/**
 * A preset's model, reasoning and permission, read out of — and written back into — its flags.
 *
 * The flags stay the stored truth on purpose. Automations and Factory read the same preset in Rust
 * (`automation_host.rs::read_presets`, `factory_host.rs::with_model`) and know only `agent` and
 * `args`; a separate `model` field would be a setting those runs never see. So the pickers are a
 * way of WRITING flags, and reading a preset means lifting the flags they own back out of `args`.
 *
 * Lifting is also what keeps an old preset honest: `Alwi` was saved as
 * `ccs acme` + `--dangerously-skip-permissions`, and must open as Full access, not Ask first.
 */

/** Which CLI a preset runs, as far as its flags are concerned. */
export type PresetFamily = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "other";

export type PresetPermission = "safe" | "yolo";

export interface PresetTuning {
  /** As the CLI takes it (`sonnet`, `gpt-5.6-sol`); null = whatever the CLI starts on. */
  model: string | null;
  /** null = the CLI's own default. */
  effort: ReasoningLevel | null;
  /** null when Lotus knows no flag that turns this agent's approvals off. */
  permission: PresetPermission | null;
  /** Every flag the pickers do not own, verbatim and in order. */
  extra: string;
}

/** `ccs` and `csp` are profile wrappers around `claude` and forward its flags. */
const CLAUDE_PROGRAMS = new Set(["claude", "ccs", "csp"]);

export function presetFamily(agent: string): PresetFamily {
  const program = agent.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (CLAUDE_PROGRAMS.has(program)) return "claude";
  if (program === "codex") return "codex";
  if (program === "cursor" || program === "cursor-agent") return "cursor";
  if (program === "gemini") return "gemini";
  if (program === "opencode") return "opencode";
  return "other";
}

/** Same table as `applyPermissionMode` (`agent-gating.ts`), keyed by family. */
const SKIP_FLAG: Partial<Record<PresetFamily, string>> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  gemini: "--yolo",
};

export function permissionFlag(family: PresetFamily): string | null {
  return SKIP_FLAG[family] ?? null;
}

/** Families whose model and effort Lotus can write as flags — the ones `runnerTuningArgv` knows. */
export function tunesModel(family: PresetFamily): family is "claude" | "codex" {
  return family === "claude" || family === "codex";
}

const EFFORT_KEY = "model_reasoning_effort";

function asLevel(raw: string): ReasoningLevel | null {
  const value = raw.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  return (REASONING_LEVELS as readonly string[]).includes(value) ? normalizeReasoningLevel(value) : null;
}

/** `--flag value` or `--flag=value`; returns the value and how many tokens it used. */
function valueOf(tokens: string[], i: number, names: readonly string[]): { value: string; used: number } | null {
  const token = tokens[i];
  for (const name of names) {
    if (token === name && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
      return { value: tokens[i + 1], used: 2 };
    }
    if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), used: 1 };
  }
  return null;
}

/**
 * The pickers' view of a preset. A value the pickers cannot represent — an effort the CLI does
 * not accept, say — is left in `extra` rather than dropped or "corrected", so the command that
 * runs never changes just because the preset was opened.
 */
export function readPresetTuning(agent: string, args: string): PresetTuning {
  const family = presetFamily(agent);
  const skip = permissionFlag(family);
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  const extra: string[] = [];
  let model: string | null = null;
  let effort: ReasoningLevel | null = null;
  let yolo = false;

  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i];
    if (skip && token === skip) {
      yolo = true;
      i += 1;
      continue;
    }
    if (tunesModel(family)) {
      const m = valueOf(tokens, i, family === "codex" ? ["--model", "-m"] : ["--model"]);
      if (m) {
        model = m.value;
        i += m.used;
        continue;
      }
      if (family === "claude") {
        const e = valueOf(tokens, i, ["--effort"]);
        const level = e ? asLevel(e.value) : null;
        if (e && level) {
          effort = level;
          i += e.used;
          continue;
        }
      } else {
        const c = valueOf(tokens, i, ["--config", "-c"]);
        const cut = c ? c.value.indexOf("=") : -1;
        const key = cut > 0 ? c?.value.slice(0, cut) : undefined;
        const raw = cut > 0 ? c?.value.slice(cut + 1) : undefined;
        const level = key === EFFORT_KEY && raw !== undefined ? asLevel(raw) : null;
        if (c && level) {
          effort = level;
          i += c.used;
          continue;
        }
      }
    }
    extra.push(token);
    i += 1;
  }

  return { model, effort, permission: skip ? (yolo ? "yolo" : "safe") : null, extra: extra.join(" ") };
}

/**
 * The flags for a tuning. Positional words that LEAD the extra flags stay in front — `ccs`
 * written as `agent: "ccs"`, `args: "acme …"` needs its profile before any flag. The extra
 * flags come last, so a flag typed there wins over the picker (the CLI keeps the last value);
 * {@link overriddenByExtra} is how the editor says so.
 *
 * Codex effort is written as `--config` rather than `-c`: Automations' Rust path treats `-c` as
 * Claude's `--continue` and drops it (`agent.rs::OWNED_FLAGS`), which would leave the value behind
 * as a stray argument. The value is unquoted because codex reads a value that is not TOML as a
 * literal string (`codex --help`), and an unquoted one survives both a shell and a whitespace split.
 */
export function composePresetArgs(agent: string, tuning: PresetTuning): string {
  const family = presetFamily(agent);
  const extra = tuning.extra.trim() ? tuning.extra.trim().split(/\s+/) : [];
  const lead: string[] = [];
  while (extra.length && !extra[0].startsWith("-")) lead.push(extra.shift() as string);

  const flags: string[] = [];
  if (tunesModel(family)) {
    if (tuning.model?.trim()) flags.push("--model", tuning.model.trim());
    if (tuning.effort) {
      flags.push(...(family === "claude" ? ["--effort", tuning.effort] : ["--config", `${EFFORT_KEY}=${tuning.effort}`]));
    }
  }
  const skip = permissionFlag(family);
  if (skip && tuning.permission === "yolo") flags.push(skip);

  return [...lead, ...flags, ...extra].join(" ");
}

/** Flags typed under Extra flags that repeat a picker — and, coming last, override it. */
export function overriddenByExtra(agent: string, extra: string): string[] {
  const family = presetFamily(agent);
  const lifted = readPresetTuning(agent, extra);
  const found: string[] = [];
  if (lifted.model) found.push(family === "codex" ? "--model / -m" : "--model");
  if (lifted.effort) found.push(family === "codex" ? EFFORT_KEY : "--effort");
  if (lifted.permission === "yolo") found.push(permissionFlag(family) as string);
  return found;
}

// ── Choices ──────────────────────────────────────────────────────────────

export interface PresetModelChoice {
  /** What reaches `--model`. */
  value: string;
  label: string;
  description?: string;
  cost?: "low" | "medium" | "high";
  efforts: readonly ReasoningLevel[];
  /** Saved in a preset, but no longer offered by the catalog or the CLI. */
  stale?: boolean;
  /** A moving alias, and the model it runs today: a preset saving it moves to the next release. */
  resolvesTo?: string;
}

/** A model as the CLI itself reports it (`lib/tauri/agent-models.ts`). */
export interface LivePresetModel {
  value: string;
  label: string;
  description?: string;
  efforts: readonly string[];
  resolvesTo?: string;
}

const PROVIDER: Record<"claude" | "codex", ModelProvider> = { claude: "claude", codex: "codex" };

/** What effort the CLI takes when no model is pinned, or the model is not in the catalog. */
const FALLBACK_EFFORTS: Record<"claude" | "codex", readonly ReasoningLevel[]> = {
  claude: CLAUDE_EFFORTS,
  // The level set every current codex model accepts; wider tiers are per model.
  codex: CODEX_EFFORTS_XHIGH,
};

/**
 * The models offered for a family. The CLI's own list wins when it answered (`live`): its names,
 * order and levels are the provider speaking, the way bb shows them. Otherwise the catalog's
 * Agents list, then anything `--help` named that the catalog does not know. Either way the
 * preset's own model is added if nobody offers it — a saved choice is shown as saved, not
 * silently swapped for a default.
 */
export function presetModelChoices(
  family: PresetFamily,
  discovered: readonly string[] = [],
  saved: string | null = null,
  formatLabel: (value: string) => string = (value) => value,
  live: readonly LivePresetModel[] | null = null,
): PresetModelChoice[] {
  if (!tunesModel(family)) return [];
  const choices: PresetModelChoice[] = live?.length
    ? live.map((model) => ({
        value: model.value,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
        efforts: model.efforts.map(asLevel).filter((level): level is ReasoningLevel => level !== null),
        ...(model.resolvesTo ? { resolvesTo: model.resolvesTo } : {}),
      }))
    : catalogChoices(family, discovered, formatLabel);
  if (saved && !choices.some((choice) => sameModel(choice.value, saved))) {
    const entry = findModel(saved);
    choices.push({
      value: saved,
      label: entry?.label ?? formatLabel(saved),
      efforts: entry?.supportedEfforts ?? FALLBACK_EFFORTS[family],
      stale: true,
    });
  }
  return choices;
}

function catalogChoices(
  family: "claude" | "codex",
  discovered: readonly string[],
  formatLabel: (value: string) => string,
): PresetModelChoice[] {
  const catalog = MODEL_CATALOG.filter((entry) => entry.provider === PROVIDER[family] && entry.availability.agents);
  const choices: PresetModelChoice[] = catalog.map((entry) => ({
    value: entry.shorthand ?? entry.fullId ?? entry.id,
    label: entry.label,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.cost ? { cost: entry.cost } : {}),
    efforts: entry.supportedEfforts,
  }));
  const known = (value: string) => Boolean(findModel(value)) || choices.some((choice) => choice.value === value);
  for (const value of discovered) {
    const trimmed = value.trim();
    if (!trimmed || known(trimmed)) continue;
    choices.push({ value: trimmed, label: formatLabel(trimmed), efforts: FALLBACK_EFFORTS[family] });
  }
  return choices;
}

/**
 * The row a saved model belongs to. Exact first: the CLI lists `opus` (moving) and `claude-opus-5`
 * (pinned) as two rows, and the catalog's alias table would otherwise tick both.
 */
export function chosenChoice(choices: readonly PresetModelChoice[], saved: string | null): PresetModelChoice | undefined {
  if (!saved) return undefined;
  return choices.find((choice) => choice.value === saved) ?? choices.find((choice) => sameModel(choice.value, saved));
}

function findModel(value: string) {
  const needle = value.trim();
  return MODEL_CATALOG.find((entry) => entry.id === needle || entry.fullId === needle || entry.shorthand === needle);
}

/** `opus` and `claude-opus-5` are the same pick. */
export function sameModel(a: string, b: string): boolean {
  if (a === b) return true;
  const entry = findModel(a);
  return Boolean(entry && (entry.id === b || entry.fullId === b || entry.shorthand === b));
}

/**
 * The levels a model accepts: what its row says (the CLI's own list when it answered), else the
 * catalog, else the family's safe set.
 */
export function presetEfforts(
  family: PresetFamily,
  model: string | null,
  choices: readonly PresetModelChoice[] = [],
): readonly ReasoningLevel[] {
  if (!tunesModel(family)) return [];
  const row = chosenChoice(choices, model);
  if (row) return row.efforts;
  const entry = model ? findModel(model) : undefined;
  return entry?.supportedEfforts ?? FALLBACK_EFFORTS[family];
}

const EFFORT_LABEL: Record<ReasoningLevel, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

export function effortLabel(level: ReasoningLevel): string {
  return EFFORT_LABEL[level];
}

/**
 * One line for a list row: `Sonnet 5.5 · High`, or `CLI default`. `liveLabel` is the CLI's own
 * name for the model when it has answered — the catalog's can lag a release behind.
 */
export function presetSummary(
  agent: string,
  args: string,
  liveLabel?: (model: string) => string | undefined,
): { text: string; fullAccess: boolean } {
  const tuning = readPresetTuning(agent, args);
  const model = tuning.model ? (liveLabel?.(tuning.model) ?? findModel(tuning.model)?.label ?? tuning.model) : null;
  const parts = [model ?? "CLI default", tuning.effort ? effortLabel(tuning.effort) : null].filter(Boolean);
  return { text: parts.join(" · "), fullAccess: tuning.permission === "yolo" };
}
