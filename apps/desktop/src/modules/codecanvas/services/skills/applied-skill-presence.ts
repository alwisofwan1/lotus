/**
 * Is an applied skill still sitting in the target's prompt?
 *
 * The Applied-Skill Guard remembers what was sent this session, which is useful but goes stale the
 * instant the operator deletes the token they were handed — the skill then reads as "applied"
 * forever while the prompt no longer mentions it.
 *
 * So the marker is derived from the prompt itself instead of trusted outright. Two honest limits
 * shape the contract:
 *
 * - The prompt text Lotus can see is a MIRROR of the bytes it wrote, not the CLI's own composer
 *   (see `pane-ask-buffer.ts`), so it can be wrong. This therefore only drives a MARKER; applying
 *   is never blocked by it. A wrong answer costs a mis-coloured badge, nothing more.
 * - No readable line at all (`null`) means "no evidence either way", and the remembered flag stands.
 *   That keeps a pane with no mirror exactly where it was.
 *
 * Pure — the caller supplies the line.
 */
import { bareSkillName } from "./skill-invocation";

/**
 * `true` when the prompt still shows this skill, `false` when it demonstrably does not.
 *
 * Matches the bare name rather than a runner-specific token: whichever sigil was inserted, and
 * whether it went in as `$teach` or as a path ending in `/teach/SKILL.md`, the name is the part
 * that survives. Deleting the token deletes the name with it, which is the event being detected.
 */
export function promptStillShowsSkill(promptLine: string | null, skillName: string): boolean {
  if (promptLine === null) return true;
  const name = bareSkillName(skillName);
  if (!name) return true;
  return promptLine.toLowerCase().includes(name.toLowerCase());
}

/**
 * Fold the remembered flag together with the evidence.
 *
 * Only ever narrows: a skill never becomes "applied" because of what is in the prompt, it only
 * stops being applied when the prompt proves the token is gone.
 */
export function isSkillStillApplied(
  remembered: boolean,
  promptLine: string | null,
  skillName: string,
): boolean {
  return remembered && promptStillShowsSkill(promptLine, skillName);
}
