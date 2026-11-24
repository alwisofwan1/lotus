import { normalizeReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";
import type { AgentDefinition } from "../../types/canvas";

// Claude 5 family (2026-09-09). These ride to the CLI as `--model`, so they are pinned ids rather
// than the "opus"/"sonnet" aliases: the config should record which model actually ran.
// Note `src/config/models/catalog.ts` still lists only 4-6/4-7 entries — stale, and tracked
// separately; it never gated these constants.
export const OPUS = "claude-opus-5";
export const SONNET = "claude-sonnet-5";
export const HAIKU = "claude-haiku-4-5";

/** Editable shape of one default agent; `slug` forms the stable id (`agent-${slug}`). */
export interface AgentSpec {
  slug: string;
  name: string;
  role: string;
  model: string;
  effort: "minimal" | "low" | "medium" | "high" | "max";
  mode: "full" | "safe";
  prompt: string;
  /** Claude Code slash-command skills this agent invokes during a run (e.g. "tdd", "diagnose"). */
  skills?: string[];
}

/** Shared preamble every default agent inherits in its prompt -- standalone-but-composable (ADR 0010). */
export const COMPOSABLE_PREAMBLE =
  "You run headless and one-shot on a visual canvas; no human is available, so resolve every ambiguity yourself, state each assumption in one line, and finish autonomously. Treat any context provided inline above (connected notes, upstream handoffs, shared-context artifacts) as your task input. First orient by reading the repo -- CLAUDE.md/CONTEXT.md/README, manifests, and neighboring code -- and detect the stack and conventions rather than assuming them. End with a concise, structured summary so a downstream agent can build on your work without re-reading your trace.";

/** Builds a persistable AgentDefinition from a spec -- fills the stable id, skills, and clock. */
export function defineAgent(spec: AgentSpec): AgentDefinition {
  return {
    id: `agent-${spec.slug}`,
    name: spec.name,
    role: spec.role,
    model: spec.model,
    prompt: spec.prompt,
    appliedSkills: spec.skills ?? [],
    effort: normalizeReasoningLevel(spec.effort),
    permissionMode: spec.mode,
    updatedAt: 0,
  };
}
