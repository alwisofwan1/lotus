import type { ReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";
import { MODEL_CATALOG, type ModelEntry, type ModelProvider } from "./catalog";

/**
 * Use-case specific projections of the catalog. Each consumer surface
 * (CodeChat, Bridge planner, Team Builder, Pane Title) reads through one
 * of these helpers and never iterates `MODEL_CATALOG` directly.
 */

function filterAvailable(
  flag: keyof ModelEntry["availability"],
  provider?: ModelProvider,
): ModelEntry[] {
  return MODEL_CATALOG.filter((entry) => {
    if (provider && entry.provider !== provider) return false;
    return entry.availability[flag] === true;
  });
}

// ── CodeChat ────────────────────────────────────────────────────────────

export type CodeChatModelOption = { label: string; value: string };

/**
 * CodeChat dropdowns use shorthand identifiers (the same string is passed
 * to `claude --model X` / `codex exec --model X`).
 */
export function getCodeChatModelOptions(provider: ModelProvider): CodeChatModelOption[] {
  // One option per value: Opus 5 and Opus 4.6 both run as `opus`, and a picker keyed by value
  // drew two React children with one key. The catalog lists the current one first.
  const byValue = new Map<string, CodeChatModelOption>();
  for (const entry of filterAvailable("codechat", provider)) {
    if (entry.shorthand && !byValue.has(entry.shorthand)) byValue.set(entry.shorthand, { label: entry.label, value: entry.shorthand });
  }
  return [...byValue.values()];
}

// ── Bridge Planner ──────────────────────────────────────────────────────

export type PlannerCatalogModel = {
  id: string;
  provider: ModelProvider;
  label: string;
  modelId: string;
  badge?: string;
  supportsEffort: boolean;
};

/**
 * Bridge planner expects a per-provider grouping. Claude entries pass the
 * shorthand to `claude --model`; Codex entries pass the fullId to `codex exec`.
 */
export function getPlannerModelsByProvider(provider: ModelProvider): PlannerCatalogModel[] {
  return filterAvailable("bridgePlanner", provider).map((entry) => {
    const modelId =
      provider === "claude"
        ? entry.shorthand ?? entry.fullId ?? entry.id
        : entry.fullId ?? entry.shorthand ?? entry.id;
    return {
      id: entry.shorthand ?? entry.fullId ?? entry.id,
      provider: entry.provider,
      label: entry.label,
      modelId,
      badge: entry.badge,
      // Derived, so there is one source: a model with no accepted level has no effort knob.
      supportsEffort: entry.supportedEfforts.length > 0,
    };
  });
}

// ── Pane Title (Auto Title Generator) ───────────────────────────────────

export type PaneTitleModelOption = {
  id: string;
  label: string;
  description?: string;
};

export function getPaneTitleModelOptions(): PaneTitleModelOption[] {
  return filterAvailable("paneTitle")
    .filter((entry) => typeof entry.fullId === "string")
    .map((entry) => ({
      id: entry.fullId!,
      label: entry.label,
      description: entry.description,
    }));
}

// ── Agents dialog (Swarm → Agents) ──────────────────────────────────────

export type AgentModelOption = {
  /** The id that reaches the CLI: `fullId` when there is one, else the shorthand. */
  id: string;
  label: string;
  description?: string;
  badge?: string;
};

/**
 * Model choices for one provider in the Agents dialog.
 *
 * Empty for a provider whose `--model` flag Lotus does not know (`cursor`, and anything running as
 * a bare custom command): `agent-tuning.ts` drops the flag for those, so offering a list would be
 * a promise the launch path cannot keep.
 */
export function getAgentModelOptions(provider: ModelProvider): AgentModelOption[] {
  return filterAvailable("agents", provider).map((entry) => ({
    id: entry.fullId ?? entry.shorthand ?? entry.id,
    label: entry.label,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.badge ? { badge: entry.badge } : {}),
  }));
}

/**
 * The reasoning levels a model accepts, by catalog id, `fullId`, or shorthand.
 *
 * Shorthand counts because that is what is actually stored and passed to the CLI for Claude
 * (`--model opus`). An unknown model returns an empty list rather than a guess — a wrong level is
 * ignored silently by the CLI, which is exactly how `minimal` went unnoticed.
 */
export function getModelEfforts(model: string): readonly ReasoningLevel[] {
  const needle = model.trim();
  if (!needle) return [];
  const entry = MODEL_CATALOG.find(
    (candidate) =>
      candidate.id === needle || candidate.fullId === needle || candidate.shorthand === needle,
  );
  return entry?.supportedEfforts ?? [];
}

/**
 * The level a model starts on when the provider states one, else `null`.
 *
 * Only codex publishes this today (one per model, in its own cache), and it is not always
 * `medium`: GPT-6-Astra and Sol start at `low`. `null` means "the provider never said", which is
 * different from "medium" and must not be printed as if it were the provider's choice.
 */
export function getModelDefaultEffort(model: string): ReasoningLevel | null {
  const needle = model.trim();
  if (!needle) return null;
  const entry = MODEL_CATALOG.find(
    (candidate) =>
      candidate.id === needle || candidate.fullId === needle || candidate.shorthand === needle,
  );
  return entry?.defaultEffort ?? null;
}
