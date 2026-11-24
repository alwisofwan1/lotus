import { describe, expect, it } from "vitest";
import { isSkillStillApplied, promptStillShowsSkill } from "../applied-skill-presence";

describe("promptStillShowsSkill", () => {
  it("sees the skill while its token is in the prompt, whatever the sigil", () => {
    expect(promptStillShowsSkill("/canvas-design ", "canvas-design")).toBe(true);
    expect(promptStillShowsSkill("$canvas-design write me a poster", "canvas-design")).toBe(true);
  });

  it("sees it inside an inserted file reference too", () => {
    expect(promptStillShowsSkill("Read and apply the skill at /g/skills/bro/SKILL.md ", "bro")).toBe(true);
  });

  it("reports it gone once the operator deletes the token", () => {
    expect(promptStillShowsSkill("write me a poster", "canvas-design")).toBe(false);
    expect(promptStillShowsSkill("", "canvas-design")).toBe(false);
  });

  it("ignores a leading sigil on the stored name and matches case-insensitively", () => {
    expect(promptStillShowsSkill("$Canvas-Design", "/canvas-design")).toBe(true);
  });

  it("treats an unreadable prompt as no evidence, not as absence", () => {
    expect(promptStillShowsSkill(null, "canvas-design")).toBe(true);
  });
});

describe("isSkillStillApplied", () => {
  it("only ever narrows — the prompt cannot mark an unapplied skill applied", () => {
    expect(isSkillStillApplied(false, "$canvas-design", "canvas-design")).toBe(false);
  });

  it("drops the marker when the token was deleted", () => {
    expect(isSkillStillApplied(true, "just some prose", "canvas-design")).toBe(false);
  });

  it("keeps the marker while the token is there, or when nothing can be read", () => {
    expect(isSkillStillApplied(true, "$canvas-design ", "canvas-design")).toBe(true);
    expect(isSkillStillApplied(true, null, "canvas-design")).toBe(true);
  });
});
