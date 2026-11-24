import { buildAgentRunPrompt, type AgentContextSource } from "./agent-run-prompt";
import { shellQuote } from "./task-terminal-command";

export interface PromotedAgentPromptInput {
  rolePrompt: string;
  appliedSkills?: string[];
  context?: AgentContextSource[];
  roster?: string[];
  skipPermissions?: boolean;
}

export interface PromotedAgentCommandOptions {
  model: string;
  effort?: string;
  skipPermissions?: boolean;
  /** When true, append carriage return so the PTY submits the command. Defaults to false. */
  submit?: boolean;
}

export interface AgentTerminalPromotionPayload extends PromotedAgentPromptInput {
  name: string;
  model: string;
  runCwd: string;
  effort?: string;
}

/**
 * Builds the prompt scope a promoted terminal agent receives. A promoted agent is a
 * LIVE persona (ADR-0022): a human watches it and other agents can read/hand off to it,
 * so it gets the interactive operating contract — reusing the same context/skill assembly
 * as a headless run.
 */
export function buildPromotedAgentPrompt(input: PromotedAgentPromptInput): string {
  return buildAgentRunPrompt({
    rolePrompt: input.rolePrompt,
    operatingMode: "live",
    skills: input.appliedSkills,
    context: input.context,
    roster: input.roster,
    skipPermissions: input.skipPermissions,
  });
}

/**
 * Builds an interactive Claude command for a promoted Canvas Agent Node.
 * By default this only pre-fills the terminal prompt; callers opt into submit.
 */
export function buildPromotedAgentCommand(
  prompt: string,
  { model, effort, skipPermissions = true, submit = false }: PromotedAgentCommandOptions,
): string {
  const parts = ["claude", "--model", shellQuote(model)];
  if (effort?.trim()) parts.push("--effort", shellQuote(effort));
  if (skipPermissions) parts.push("--dangerously-skip-permissions");
  parts.push(shellQuote(prompt));
  return `${parts.join(" ")}${submit ? "\r" : ""}`;
}
