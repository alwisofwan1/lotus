import type { ModelOption } from "./codex-models.js";

/** Use CLI aliases so the provider can update each model tier without a host release. */
export const CLAUDE_MODELS: ModelOption[] = [
  { slug: "fable", displayName: "Fable 5" },
  { slug: "opus", displayName: "Opus 5" },
  { slug: "sonnet", displayName: "Sonnet 5" },
  { slug: "haiku", displayName: "Haiku 4.5" },
];

/** What the CLI picks unasked, so a turn that names nothing lands where the CLI would. */
const DEFAULT_CLAUDE_MODEL = "sonnet";

/** Picks the model to send for a claude turn: the selection if valid, else sonnet. */
export function resolveClaudeModel(selected: string | undefined): string {
  return CLAUDE_MODELS.some((m) => m.slug === selected) ? (selected as string) : DEFAULT_CLAUDE_MODEL;
}
