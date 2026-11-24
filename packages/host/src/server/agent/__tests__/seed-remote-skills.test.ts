import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRemoteSkills } from "../seed-remote-skills.js";

describe("seedRemoteSkills", () => {
  let seedDir: string;
  let mount: string;

  beforeEach(() => {
    seedDir = mkdtempSync(join(tmpdir(), "skill-seed-"));
    mount = mkdtempSync(join(tmpdir(), "skill-mount-"));
    for (const name of ["github", "aws"]) {
      mkdirSync(join(seedDir, name), { recursive: true });
      writeFileSync(join(seedDir, name, "SKILL.md"), `# ${name} skill`);
    }
  });
  afterEach(() => {
    rmSync(seedDir, { recursive: true, force: true });
    rmSync(mount, { recursive: true, force: true });
  });

  const skillPath = (name: string) => join(mount, ".claude", "skills", name, "SKILL.md");

  it("copies bundled skills into <mount>/.claude/skills and returns their names", () => {
    const seeded = seedRemoteSkills(seedDir, mount);
    expect(new Set(seeded)).toEqual(new Set(["github", "aws"]));
    expect(readFileSync(skillPath("github"), "utf8")).toContain("github skill");
    expect(existsSync(skillPath("aws"))).toBe(true);
  });

  it("is non-destructive — never overwrites a skill the operator already placed", () => {
    mkdirSync(join(mount, ".claude", "skills", "github"), { recursive: true });
    writeFileSync(skillPath("github"), "OPERATOR EDIT");
    const seeded = seedRemoteSkills(seedDir, mount);
    expect(seeded).toEqual(["aws"]); // github skipped
    expect(readFileSync(skillPath("github"), "utf8")).toBe("OPERATOR EDIT");
  });

  it("skips files and dotfiles in the seed dir", () => {
    writeFileSync(join(seedDir, "README.md"), "not a skill");
    mkdirSync(join(seedDir, ".hidden"));
    const seeded = seedRemoteSkills(seedDir, mount);
    expect(new Set(seeded)).toEqual(new Set(["github", "aws"]));
  });

  it("returns [] when the seed dir does not exist (nothing bundled)", () => {
    expect(seedRemoteSkills(join(seedDir, "absent"), mount)).toEqual([]);
  });

  it("is idempotent — a second run seeds nothing new", () => {
    seedRemoteSkills(seedDir, mount);
    expect(seedRemoteSkills(seedDir, mount)).toEqual([]);
  });
});
