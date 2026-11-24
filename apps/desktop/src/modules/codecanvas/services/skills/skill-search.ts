/**
 * Ranking and grouping for the Skills node's browser.
 *
 * A flat alphabetical list of 20+ skills is unreadable — the panel had no search at
 * all, so finding `/frontend-design` meant scrolling past everything before it. The
 * tiers here mirror the canvas command sheet's relevance model so both surfaces feel
 * like one system: an exact name beats a prefix, a prefix beats a segment, a name
 * beats a description, and a loose subsequence is the last resort.
 *
 * Pure — no React, no storage.
 */
import type { SkillEntry } from "@/lib/tauri/skills";

export type SkillSourceFilter = "all" | "project" | "global";

export interface RankedSkill {
  skill: SkillEntry;
  score: number;
}

export interface SkillGroup {
  /** Stable id — also the test hook and the `key`. */
  id: "recent" | "project" | "global" | "results";
  label: string;
  skills: SkillEntry[];
}

export const SKILL_SCORE = {
  exactName: 100,
  namePrefix: 90,
  segmentPrefix: 70,
  nameContains: 50,
  descriptionContains: 30,
  subsequence: 10,
  none: 0,
} as const;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Segments of a skill name — `github:gh-fix-ci` → ["github", "gh", "fix", "ci"]. */
function nameSegments(name: string): string[] {
  return name.split(/[-:_/\s]+/).filter(Boolean);
}

function isSubsequence(query: string, target: string): boolean {
  let index = 0;
  for (const char of target) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return query.length === 0;
}

/** How well one skill matches `query`. `SKILL_SCORE.none` means "do not show". */
export function scoreSkill(skill: SkillEntry, query: string): number {
  const q = normalize(query);
  if (!q) return SKILL_SCORE.exactName;

  const name = normalize(skill.name);
  if (name === q) return SKILL_SCORE.exactName;
  if (name.startsWith(q)) return SKILL_SCORE.namePrefix;
  if (nameSegments(name).some((segment) => segment.startsWith(q))) return SKILL_SCORE.segmentPrefix;
  if (name.includes(q)) return SKILL_SCORE.nameContains;
  if (normalize(skill.description ?? "").includes(q)) return SKILL_SCORE.descriptionContains;
  if (isSubsequence(q, name)) return SKILL_SCORE.subsequence;
  return SKILL_SCORE.none;
}

export function matchesSourceFilter(skill: SkillEntry, filter: SkillSourceFilter): boolean {
  return filter === "all" || skill.source === filter;
}

export interface RankSkillsOptions {
  query?: string;
  source?: SkillSourceFilter;
  /** Most-recently-used names, most recent first — breaks ties and drives the Recent group. */
  recents?: readonly string[];
}

/**
 * The matching skills, best first. Ties resolve by project-before-global, then by
 * recency, then alphabetically — so the order is fully determined and never jitters
 * between renders.
 */
export function rankSkills(
  skills: readonly SkillEntry[],
  { query = "", source = "all", recents = [] }: RankSkillsOptions = {},
): SkillEntry[] {
  const recentRank = new Map(recents.map((name, index) => [name, index]));

  return skills
    .filter((skill) => matchesSourceFilter(skill, source))
    .map((skill) => ({ skill, score: scoreSkill(skill, query) }))
    .filter((ranked) => ranked.score > SKILL_SCORE.none)
    .sort((left, right) =>
      right.score - left.score ||
      sourceRank(left.skill) - sourceRank(right.skill) ||
      (recentRank.get(left.skill.name) ?? Number.MAX_SAFE_INTEGER) -
        (recentRank.get(right.skill.name) ?? Number.MAX_SAFE_INTEGER) ||
      left.skill.name.localeCompare(right.skill.name),
    )
    .map((ranked) => ranked.skill);
}

function sourceRank(skill: SkillEntry): number {
  return skill.source === "project" ? 0 : 1;
}

/**
 * Sectioned view for the list. Browsing (no query) keeps the familiar
 * Recent / Project / Global structure; searching collapses to one ranked list,
 * because relevance order and grouping fight each other.
 */
export function groupSkills(
  skills: readonly SkillEntry[],
  options: RankSkillsOptions = {},
): SkillGroup[] {
  const ranked = rankSkills(skills, options);
  if (normalize(options.query ?? "")) {
    return ranked.length > 0 ? [{ id: "results", label: "Results", skills: ranked }] : [];
  }

  const recentNames = new Set(options.recents ?? []);
  const recent = (options.recents ?? [])
    .map((name) => ranked.find((skill) => skill.name === name))
    .filter((skill): skill is SkillEntry => !!skill);
  const rest = ranked.filter((skill) => !recentNames.has(skill.name));

  return [
    { id: "recent" as const, label: "Recent", skills: recent },
    { id: "project" as const, label: "Project", skills: rest.filter((s) => s.source === "project") },
    { id: "global" as const, label: "Global", skills: rest.filter((s) => s.source === "global") },
  ].filter((group) => group.skills.length > 0);
}

/** The groups flattened back into keyboard-navigation order. */
export function flattenSkillGroups(groups: readonly SkillGroup[]): SkillEntry[] {
  return groups.flatMap((group) => group.skills);
}
