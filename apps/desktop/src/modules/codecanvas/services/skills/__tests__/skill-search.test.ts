import { describe, expect, it } from "vitest";
import type { SkillEntry } from "@/lib/tauri/skills";
import {
  SKILL_SCORE,
  flattenSkillGroups,
  groupSkills,
  rankSkills,
  scoreSkill,
} from "../skill-search";

function skill(name: string, source: "project" | "global" = "global", description = ""): SkillEntry {
  return { name, description, content: `# ${name}`, source, path: `/skills/${name}/SKILL.md` };
}

const SKILLS: SkillEntry[] = [
  skill("teach", "project", "Teach the user a new skill or concept."),
  skill("imagegen", "project", "Generate or edit raster images."),
  skill("frontend-design", "global", "Create distinctive frontend interfaces."),
  skill("find-skills", "global", "Discover and install agent skills."),
  skill("github:gh-fix-ci", "global", "Fix a failing CI run."),
  skill("bro", "global", "Turn a ticket into a plain-language summary."),
];

describe("scoreSkill", () => {
  it("tiers exact name above prefix above segment above contains", () => {
    expect(scoreSkill(skill("teach"), "teach")).toBe(SKILL_SCORE.exactName);
    expect(scoreSkill(skill("teach"), "tea")).toBe(SKILL_SCORE.namePrefix);
    expect(scoreSkill(skill("frontend-design"), "des")).toBe(SKILL_SCORE.segmentPrefix);
    expect(scoreSkill(skill("frontend-design"), "nd-de")).toBe(SKILL_SCORE.nameContains);
  });

  it("falls back to the description, then to a loose subsequence", () => {
    expect(scoreSkill(skill("bro", "global", "Turn a ticket into a summary"), "ticket"))
      .toBe(SKILL_SCORE.descriptionContains);
    expect(scoreSkill(skill("frontend-design"), "fds")).toBe(SKILL_SCORE.subsequence);
  });

  it("scores a non-match as none", () => {
    expect(scoreSkill(skill("teach"), "zzzz")).toBe(SKILL_SCORE.none);
  });

  it("treats an empty query as a match so browsing shows everything", () => {
    expect(scoreSkill(skill("teach"), "   ")).toBe(SKILL_SCORE.exactName);
  });
});

describe("rankSkills", () => {
  it("puts the best match first, not the alphabetically first", () => {
    expect(rankSkills(SKILLS, { query: "skill" }).map((s) => s.name))
      .toEqual(["find-skills", "teach"]);
  });

  it("excludes non-matches entirely", () => {
    expect(rankSkills(SKILLS, { query: "zzzz" })).toEqual([]);
  });

  it("honours the source filter", () => {
    expect(rankSkills(SKILLS, { source: "project" }).map((s) => s.name))
      .toEqual(["imagegen", "teach"]);
  });

  it("breaks equal scores with project first, then recency, then alphabetically", () => {
    const tied = [skill("alpha", "global"), skill("beta", "global"), skill("gamma", "project")];

    expect(rankSkills(tied).map((s) => s.name)).toEqual(["gamma", "alpha", "beta"]);
    expect(rankSkills(tied, { recents: ["beta"] }).map((s) => s.name)).toEqual(["gamma", "beta", "alpha"]);
  });
});

describe("groupSkills", () => {
  it("browsing splits into Recent / Project / Global", () => {
    const groups = groupSkills(SKILLS, { recents: ["bro"] });

    expect(groups.map((g) => g.id)).toEqual(["recent", "project", "global"]);
    expect(groups[0].skills.map((s) => s.name)).toEqual(["bro"]);
    // A recent skill is not repeated in its source group.
    expect(groups[2].skills.map((s) => s.name)).not.toContain("bro");
  });

  it("omits an empty group instead of rendering a bare heading", () => {
    expect(groupSkills(SKILLS).map((g) => g.id)).toEqual(["project", "global"]);
  });

  it("searching collapses to a single ranked Results group", () => {
    const groups = groupSkills(SKILLS, { query: "skill", recents: ["bro"] });

    expect(groups.map((g) => g.id)).toEqual(["results"]);
    expect(groups[0].skills.map((s) => s.name)).toEqual(["find-skills", "teach"]);
  });

  it("returns no groups when nothing matches", () => {
    expect(groupSkills(SKILLS, { query: "zzzz" })).toEqual([]);
  });
});

describe("flattenSkillGroups", () => {
  it("gives keyboard navigation one flat ordered list", () => {
    expect(flattenSkillGroups(groupSkills(SKILLS, { recents: ["bro"] })).map((s) => s.name))
      .toEqual(["bro", "imagegen", "teach", "find-skills", "frontend-design", "github:gh-fix-ci"]);
  });
});
