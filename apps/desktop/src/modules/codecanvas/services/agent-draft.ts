import { normalizeReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";
import { parseSkillNames } from "./agent-skill-prompt";
import { getAgentModelOptions } from "@/config/models/presets";
import type { AgentDefinition } from "../types/canvas";
import type { AgentRunnerType } from "@/lib/agent-runtime";

/**
 * The model a new agent starts on: the catalog's first Claude option, not a literal.
 *
 * This file used to hold its own list (`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`)
 * which drifted from `config/models/catalog.ts` — the file that documents itself as the single
 * source — and from the team presets. On 2026-09-10 the Agents dialog offered `claude-sonnet-4-6`
 * while the seeded teams ran `claude-sonnet-5`.
 */
export const defaultAgentModel = (): string => getAgentModelOptions("claude")[0]?.id ?? "";

/** Editable shape of an agent definition (form state). Skills are a comma-separated string. */
export interface AgentDraft {
  name: string;
  role: string;
  model: string;
  prompt: string;
  skills: string;
  effort: string;
  permissionMode: string;
  runner: AgentRunnerType;
  runnerCommand: string;
  /** Persona accent colour (hex); "" = none (default tint). */
  color: string;
}

export const blankAgentDraft = (): AgentDraft => ({
  name: "",
  role: "",
  model: defaultAgentModel(),
  prompt: "",
  skills: "",
  effort: "medium",
  permissionMode: "full",
  runner: "claude",
  runnerCommand: "",
  color: "",
});

export const agentDraftFromDefinition = (def: AgentDefinition): AgentDraft => ({
  name: def.name,
  role: def.role ?? "",
  model: def.model,
  prompt: def.prompt,
  skills: (def.appliedSkills ?? []).join(", "),
  effort: def.effort ?? "medium",
  permissionMode: def.permissionMode ?? "full",
  runner: def.runner ?? "claude",
  runnerCommand: def.runnerCommand ?? "",
  color: def.color ?? "",
});

/** A draft is saveable once it has a name and a prompt. */
export const isAgentDraftValid = (draft: AgentDraft): boolean =>
  draft.name.trim().length > 0 &&
  draft.prompt.trim().length > 0 &&
  (draft.runner !== "custom" || draft.runnerCommand.trim().length > 0);

/** Canonical mapping from form draft to a persistable AgentDefinition. */
export function buildAgentDefinition(draft: AgentDraft, id?: string): AgentDefinition {
  return {
    id: id ?? crypto.randomUUID(),
    name: draft.name.trim(),
    role: draft.role.trim() || undefined,
    model: draft.model,
    prompt: draft.prompt.trim(),
    appliedSkills: parseSkillNames(draft.skills),
    effort: normalizeReasoningLevel(draft.effort),
    permissionMode: draft.permissionMode,
    runner: draft.runner,
    ...(draft.runner === "custom" && draft.runnerCommand.trim() ? { runnerCommand: draft.runnerCommand.trim() } : {}),
    ...(draft.color.trim() ? { color: draft.color.trim() } : {}),
    updatedAt: 0,
  };
}
