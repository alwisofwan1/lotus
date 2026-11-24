import type { ModelOption } from "./codex-models.js";

/**
 * The Claude aliases the pickers offer, newest tier first.
 *
 * **Aliases, never pinned ids.** `claude --help` documents exactly this shape — *"Provide
 * an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')"* — so the CLI resolves
 * each one to the current model of that tier. Pinning `claude-opus-5` here instead would
 * make the list age with every release, which is the failure this file exists to avoid.
 *
 * `displayName` names the model each alias resolves to **today** (provider model table,
 * read 2026-08-27: Fable 5, Opus 5, Sonnet 5, Haiku 4.5). It is documentation, not wire
 * data: the phone labels its picker with the alias itself (`spawn-tuning.ts`), so a name
 * that ages cannot mislead anyone reading a screen.
 *
 * **Mythos 5 is deliberately absent.** It is invitation-only (Project Glasswing), and an
 * alias the account cannot use is a spawn that fails on the machine, minutes away from the
 * operator who chose it. Same reason `[1m]` and `opusplan` are not here: they are a context
 * variant and a routing mode, not models in the provider's table.
 */
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
