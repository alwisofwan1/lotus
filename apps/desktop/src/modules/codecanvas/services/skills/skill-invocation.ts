/**
 * How each CLI runner wants a skill invoked.
 *
 * Every runner has its own idiom for "run this named prompt": Claude Code takes
 * `/skill-name`, Codex takes `$skill-name`. A runner with no registry of its own has
 * to be pointed at the SKILL.md on disk instead. Keeping that in one table means the
 * text the user sees in the Skills list and the text actually inserted into the
 * prompt can never drift apart — they are both derived from here.
 *
 * Pure — no React, no I/O.
 */
import { isClaudeFamilyRunner, type AgentRunnerType } from "@/lib/agent-runtime";

export type SkillInvocationStyle =
  /** The runner has a native skill registry reachable by a one-character prefix. */
  | { kind: "sigil"; sigil: string }
  /** No registry — hand the runner the skill file and let it read the skill itself. */
  | { kind: "file-reference" };

/**
 * Per-runner sigils.
 *
 * `claude`/`ccs`/`csp` are Claude Code under the hood (see `isClaudeFamilyRunner`), so
 * they share `/`. `codex` uses `$`. Runners absent from this table fall through to a
 * file reference rather than to a guessed prefix: inserting the wrong sigil is worse
 * than being verbose, because the agent silently treats it as prose.
 */
const RUNNER_SIGILS: Partial<Record<AgentRunnerType, string>> = {
  claude: "/",
  ccs: "/",
  csp: "/",
  codex: "$",
};

export const CLAUDE_SKILL_SIGIL = "/";

export function skillInvocationStyleFor(
  runner: unknown,
  claudeFamilyOverride?: boolean,
): SkillInvocationStyle {
  const runnerType = typeof runner === "string" ? (runner as AgentRunnerType) : undefined;
  // A `custom` runner that is really Claude behind a profile opts in via the Runner
  // Registry flag — the same seam `isClaudeFamilyRunner` owns everywhere else.
  if (isClaudeFamilyRunner(runnerType, claudeFamilyOverride)) {
    return { kind: "sigil", sigil: CLAUDE_SKILL_SIGIL };
  }
  const sigil = runnerType ? RUNNER_SIGILS[runnerType] : undefined;
  return sigil ? { kind: "sigil", sigil } : { kind: "file-reference" };
}

/** Strip any leading sigil a caller already added, so tokens never double up (`//teach`). */
export function bareSkillName(name: string): string {
  return name.trim().replace(/^[/$]+/, "");
}

/**
 * What the Skills list should print for a skill under this runner — the exact token
 * the user will get. A file-reference runner has no token, so it shows the bare name.
 */
export function skillDisplayToken(style: SkillInvocationStyle, name: string): string {
  const bare = bareSkillName(name);
  return style.kind === "sigil" ? `${style.sigil}${bare}` : bare;
}

/**
 * The text inserted into a live agent's prompt to apply a skill (ADR-0027 Phase 6a) —
 * inserted, not submitted, so the user can add context then press Enter.
 *
 * A file-reference runner gets the SKILL.md's absolute path (project AND global skills
 * both resolve). With no path known there is nothing useful to insert but the name.
 */
export function formatSkillInvocation(
  style: SkillInvocationStyle,
  skill: { name: string; path?: string },
): string {
  const bare = bareSkillName(skill.name);
  if (!bare) return "";
  if (style.kind === "sigil") return `${style.sigil}${bare} `;
  return skill.path
    ? `Read and apply the skill at ${skill.path} `
    : `${CLAUDE_SKILL_SIGIL}${bare} `;
}
