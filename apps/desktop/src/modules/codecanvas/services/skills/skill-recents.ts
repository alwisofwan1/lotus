/**
 * Per-project most-recently-used skills.
 *
 * The applied-skill guard is deliberately session-only (it gates re-sending a skill
 * to a live PTY), so it cannot double as history. This is the durable half: which
 * skills this project actually reaches for, so they sit at the top of the list on
 * the next launch instead of being scrolled past again.
 *
 * localStorage, best-effort — every access is guarded because it throws outright in
 * a private window and in the thumbnail/preview contexts the canvas renders in.
 */

const STORAGE_PREFIX = "lotus.canvas.skills.recent:";
export const MAX_SKILL_RECENTS = 5;

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope || "default"}`;
}

export function readSkillRecents(scope: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey(scope));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((name): name is string => typeof name === "string").slice(0, MAX_SKILL_RECENTS);
  } catch {
    return [];
  }
}

/** Pure half — exported so ordering is testable without touching storage. */
export function withSkillRecent(recents: readonly string[], name: string): string[] {
  return [name, ...recents.filter((entry) => entry !== name)].slice(0, MAX_SKILL_RECENTS);
}

/** Record a use and return the new list (unchanged on a storage failure). */
export function recordSkillRecent(scope: string, name: string): string[] {
  const next = withSkillRecent(readSkillRecents(scope), name);
  try {
    window.localStorage.setItem(storageKey(scope), JSON.stringify(next));
  } catch {
    // A viewer with site data blocked still gets the in-memory ordering for this session.
  }
  return next;
}
