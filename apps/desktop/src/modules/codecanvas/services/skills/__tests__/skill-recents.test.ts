import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SKILL_RECENTS,
  readSkillRecents,
  recordSkillRecent,
  withSkillRecent,
} from "../skill-recents";

describe("withSkillRecent", () => {
  it("moves a repeat use to the front instead of duplicating it", () => {
    expect(withSkillRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_SKILL_RECENTS + 3 }, (_, i) => `s${i}`);
    expect(withSkillRecent(many, "new")).toHaveLength(MAX_SKILL_RECENTS);
    expect(withSkillRecent(many, "new")[0]).toBe("new");
  });
});

describe("skill recents storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips per scope", () => {
    recordSkillRecent("/repo/a", "teach");
    recordSkillRecent("/repo/a", "bro");
    recordSkillRecent("/repo/b", "imagegen");

    expect(readSkillRecents("/repo/a")).toEqual(["bro", "teach"]);
    expect(readSkillRecents("/repo/b")).toEqual(["imagegen"]);
  });

  it("returns an empty list for unseen or corrupt entries", () => {
    expect(readSkillRecents("/nope")).toEqual([]);
    window.localStorage.setItem("lotus.canvas.skills.recent:/bad", "{not json");
    expect(readSkillRecents("/bad")).toEqual([]);
  });

  it("survives storage that throws", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(readSkillRecents("/repo")).toEqual([]);
    expect(recordSkillRecent("/repo", "teach")).toEqual(["teach"]);

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
