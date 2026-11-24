/**
 * Single source of truth for AI model definitions consumed across the app.
 *
 * Every model surface (CodeChat agent dropdowns, Bridge planner picker,
 * Codeswarm team builder, automatic pane title generator, Rust spawn
 * defaults) reads from this catalog via helpers in `./presets.ts`.
 *
 * Never hardcode model identifiers in feature code — add or update an
 * entry here and let the presets project the right shape per call site.
 *
 * Rust mirror: `src-tauri/src/agent_cli/provider.rs` keeps a small fallback
 * list (`built_in_models_for_agent`) for offline discovery + the
 * `pane_title.rs`/`launch.rs` defaults. Update both when adding a model.
 */

import type { ReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";

export type ModelProvider = "claude" | "codex" | "cursor";

/**
 * Verified against the real binary on 2026-09-10:
 * `claude --effort bogus` → "Valid values: low, medium, high, xhigh, max."
 * Note there is no `minimal`; Lotus used to offer it and Claude ignored it silently.
 */
export const CLAUDE_EFFORTS: readonly ReasoningLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Conservative and **not yet verified**: probing `codex -c model_reasoning_effort="bogus"` produced
 * no validation message, so this list is the safe subset rather than a guess at the full one.
 * Verify before widening.
 */
/**
 * Codex publishes its accepted levels per model, and they genuinely differ — which is why one
 * app-wide effort list could never be right.
 *
 * Source: `~/.codex/models_cache.json`, written by codex 0.154.0 on 2026-09-10. That file is the
 * CLI's own fetched list, so it is the provider speaking rather than Lotus guessing.
 */
export const CODEX_EFFORTS_ULTRA: readonly ReasoningLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const CODEX_EFFORTS_MAX: readonly ReasoningLevel[] = ["low", "medium", "high", "xhigh", "max"];
export const CODEX_EFFORTS_XHIGH: readonly ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

/** @deprecated Kept for callers that predate the per-model tiers above. */
export const CODEX_EFFORTS: readonly ReasoningLevel[] = CODEX_EFFORTS_XHIGH;

/** Cursor's CLI takes no effort flag — `agent-tuning.ts` drops it. */
export const NO_EFFORTS: readonly ReasoningLevel[] = [];

export type ModelCostTier = "low" | "medium" | "high";

export type ModelVariant = "default" | "1m" | "plan";

export type ModelAvailability = {
  /** CodeChat agent dropdown (Claude/Codex/Cursor cells). Uses `shorthand`. */
  codechat?: boolean;
  /** Bridge planner provider menu. Uses `shorthand` for Claude, `fullId` for Codex. */
  bridgePlanner?: boolean;
  /** Codeswarm team builder + LaunchModal lead/member selectors. Uses `fullId`. */
  teamBuilder?: boolean;
  /** Auto pane title generator (Settings + sidecar). Uses `fullId`. */
  paneTitle?: boolean;
  /** Agents dialog (Swarm → Agents → New/Edit). Uses `fullId`, falling back to `shorthand`. */
  agents?: boolean;
};

export type ModelEntry = {
  /** Stable internal id, unique within the catalog. */
  id: string;
  provider: ModelProvider;
  /** Human-readable label for dropdowns, e.g. "Sonnet 4.6". */
  label: string;
  /** Short helper line for descriptive callouts (Team Builder, Pane Title). */
  description?: string;
  /** Visual badge for dropdowns, e.g. "NEW", "1M", "PREVIEW". */
  badge?: string;
  cost?: ModelCostTier;
  /**
   * The reasoning levels this model really accepts, least first. Empty = no effort knob at all,
   * and the UI must then hide the control rather than show a value the launch path drops.
   *
   * A list, not a boolean: Claude names five (`claude --effort bogus` prints them), codex spells
   * effort through a TOML override, and cursor takes none. See `lib/agent-runtime/reasoning-effort.ts`.
   */
  supportedEfforts: readonly ReasoningLevel[];
  /**
   * The level the provider itself starts this model on. Absent when the provider never said —
   * which is different from `medium` and must not be shown as if it were the provider's choice.
   */
  defaultEffort?: ReasoningLevel;
  variant?: ModelVariant;
  /** CLI alias accepted by `claude --model <x>` / `codex exec --model <x>`. */
  shorthand?: string;
  /** Fully-qualified id used by spawn_claude, team configs and pane title. */
  fullId?: string;
  availability: ModelAvailability;
};

/**
 * Catalog ordering matters for UI: Claude flagship first, then 1M variants,
 * Plan last; Codex newest first; Cursor terminal entries.
 */
export const MODEL_CATALOG: readonly ModelEntry[] = [
  // ── Claude 5 (current family, 2026-09-10) ─────────────────────────────
  // Added when the Agents dialog was still offering `claude-sonnet-4-6` while the seeded team
  // presets already ran `claude-sonnet-5`. The 4.x entries below stay so configs written against
  // them keep resolving, but they are no longer offered to the Agents dialog.
  {
    id: "claude-opus-5",
    provider: "claude",
    label: "Opus 5",
    description: "Most capable — lead, architecture, review",
    cost: "high",
    supportedEfforts: CLAUDE_EFFORTS,
    shorthand: "opus",
    fullId: "claude-opus-5",
    availability: { agents: true, teamBuilder: true, bridgePlanner: true, codechat: true },
  },
  {
    id: "claude-sonnet-5",
    provider: "claude",
    label: "Sonnet 5",
    description: "Balanced — implementation work",
    cost: "medium",
    supportedEfforts: CLAUDE_EFFORTS,
    shorthand: "sonnet",
    fullId: "claude-sonnet-5",
    availability: { agents: true, teamBuilder: true, bridgePlanner: true, codechat: true },
  },
  {
    id: "claude-haiku-5-5",
    provider: "claude",
    label: "Haiku 5.5",
    description: "Fastest — titles, summaries",
    cost: "low",
    supportedEfforts: CLAUDE_EFFORTS,
    fullId: "claude-haiku-5-5",
    availability: { paneTitle: true },
  },
  {
    id: "claude-haiku-4-5",
    provider: "claude",
    label: "Haiku 4.5",
    description: "Fastest — docs, summaries",
    cost: "low",
    supportedEfforts: CLAUDE_EFFORTS,
    shorthand: "haiku",
    fullId: "claude-haiku-4-5",
    // One entry: it used to be listed twice under the same id (here and under 4.x), so id lookups
    // found this copy while the per-surface lists read the other one's flags and description.
    availability: { agents: true, teamBuilder: true, codechat: true, bridgePlanner: true, paneTitle: true },
  },
  // ── Claude 4.x (kept for saved configs; not offered to the Agents dialog) ──
  {
    id: "claude-opus-4-6",
    provider: "claude",
    label: "Opus 4.6",
    description: "Most capable, best for lead",
    cost: "high",
    supportedEfforts: CLAUDE_EFFORTS,
    shorthand: "opus",
    fullId: "claude-opus-4-6",
    availability: { codechat: true, bridgePlanner: true, teamBuilder: true },
  },
  {
    id: "claude-opus-4-6-1m",
    provider: "claude",
    label: "Opus 4.6 1M",
    badge: "1M",
    cost: "high",
    supportedEfforts: CLAUDE_EFFORTS,
    variant: "1m",
    shorthand: "opus[1m]",
    availability: { codechat: true },
  },
  {
    id: "claude-opus-4-7",
    provider: "claude",
    label: "Opus 4.7",
    description: "Best quality",
    cost: "high",
    supportedEfforts: CLAUDE_EFFORTS,
    fullId: "claude-opus-4-7",
    availability: { paneTitle: true },
  },
  {
    id: "claude-sonnet-4-6",
    provider: "claude",
    label: "Sonnet 4.6",
    description: "Balanced performance",
    cost: "medium",
    supportedEfforts: CLAUDE_EFFORTS,
    shorthand: "sonnet",
    fullId: "claude-sonnet-4-6",
    availability: {
      codechat: true,
      bridgePlanner: true,
      teamBuilder: true,
      paneTitle: true,
    },
  },
  {
    id: "claude-sonnet-4-6-1m",
    provider: "claude",
    label: "Sonnet 4.6 1M",
    badge: "1M",
    cost: "medium",
    supportedEfforts: CLAUDE_EFFORTS,
    variant: "1m",
    shorthand: "sonnet[1m]",
    availability: { codechat: true },
  },
  {
    id: "claude-opus-plan",
    provider: "claude",
    label: "Opus Plan",
    cost: "high",
    supportedEfforts: CLAUDE_EFFORTS,
    variant: "plan",
    shorthand: "opusplan",
    availability: { codechat: true },
  },

  // ── Codex (from the CLI's own cache, 2026-09-10) ──────────────────────
  // `~/.codex/models_cache.json` (codex 0.154.0), ordered by its own `priority` field. The eight
  // entries that used to live here — gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.3-codex-spark,
  // gpt-5.2-codex, gpt-5.2, gpt-5.1-codex-max, gpt-5.1-codex-mini — are absent from that list, so
  // choosing one asked the CLI for a model that is simply gone. `gpt-reserve` and
  // `codex-auto-review` are in the cache but marked `visibility: "hide"`, so they stay out.
  {
    id: "gpt-6-astra",
    provider: "codex",
    label: "GPT-6-Astra",
    description: "Our most capable model for complex, demanding work.",
    cost: "high",
    supportedEfforts: CODEX_EFFORTS_ULTRA,
    defaultEffort: "low",
    shorthand: "gpt-6-astra",
    fullId: "gpt-6-astra",
    availability: { agents: true, codechat: true, bridgePlanner: true },
  },
  {
    id: "gpt-5.6-sol",
    provider: "codex",
    label: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    cost: "high",
    supportedEfforts: CODEX_EFFORTS_ULTRA,
    defaultEffort: "low",
    shorthand: "gpt-5.6-sol",
    fullId: "gpt-5.6-sol",
    availability: { agents: true, codechat: true, bridgePlanner: true },
  },
  {
    id: "gpt-5.6-terra",
    provider: "codex",
    label: "GPT-5.6-Terra",
    description: "Balanced agentic coding model for everyday work.",
    cost: "medium",
    supportedEfforts: CODEX_EFFORTS_ULTRA,
    defaultEffort: "medium",
    shorthand: "gpt-5.6-terra",
    fullId: "gpt-5.6-terra",
    availability: { agents: true, codechat: true, bridgePlanner: true },
  },
  {
    id: "gpt-5.6-luna",
    provider: "codex",
    label: "GPT-5.6-Luna",
    description: "Fast and affordable agentic coding model.",
    cost: "low",
    supportedEfforts: CODEX_EFFORTS_MAX,
    defaultEffort: "medium",
    shorthand: "gpt-5.6-luna",
    fullId: "gpt-5.6-luna",
    availability: { agents: true, codechat: true, bridgePlanner: true },
  },
  {
    id: "gpt-5.5",
    provider: "codex",
    label: "GPT-5.5",
    description: "Frontier model for complex coding, research, and real-world work.",
    cost: "medium",
    supportedEfforts: CODEX_EFFORTS_XHIGH,
    defaultEffort: "medium",
    shorthand: "gpt-5.5",
    fullId: "gpt-5.5",
    availability: { agents: true, codechat: true, bridgePlanner: true },
  },

  // ── Cursor ────────────────────────────────────────────────────────────
  {
    id: "cursor-auto",
    provider: "cursor",
    label: "Auto",
    supportedEfforts: NO_EFFORTS,
    shorthand: "auto",
    availability: { codechat: true },
  },
];

/**
 * Centralised default identifiers. Anything that needs a "default model"
 * must reference these — never re-declare a literal `"claude-haiku-4-5"`
 * or `"sonnet"` elsewhere.
 *
 * Mirror in Rust:
 *   - `DEFAULT_MODEL` in `src-tauri/src/pane_title.rs`
 *   - `DEFAULT_MODEL` in `src-tauri/src/chat_runtime/title.rs` (chatTitle)
 *   - lead-model fallback in `src-tauri/src/launch.rs`
 *   - `default_model_for_agent` in `src-tauri/src/agent_cli/provider.rs`
 */
export const MODEL_DEFAULTS = {
  codechat: {
    claude: "sonnet",
    // The CLI's own first choice: priority 1 in its models cache.
    codex: "gpt-6-astra",
    cursor: "auto",
  },
  paneTitle: "claude-haiku-4-5",
  /** Names a new Claude chat from its first message (Settings › Chat › Titles); Codex chats use Codex. */
  chatTitle: "claude-haiku-5-5",
  teamBuilderLead: "claude-haiku-4-5",
  teamBuilderMember: "claude-sonnet-5",
  plannerClaude: { modelId: "opus", effort: "high" as const },
  plannerCodex: { modelId: "gpt-6-astra" },
} as const;
