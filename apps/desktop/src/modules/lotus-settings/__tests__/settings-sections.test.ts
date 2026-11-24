import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS } from "../settings-sections";

describe("SETTINGS_SECTIONS registry", () => {
  it("gives every section a unique id", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is one flat list of eleven, each mode's gear section in that mode's group", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.title)).toEqual([
      "General", "Agents", "Accounts", "Voice", "Chat", "Canvas", "CodeSpace", "Worktrees", "Hotkeys", "Mobile", "About",
    ]);
    const of = (group: string) => SETTINGS_SECTIONS.filter((s) => s.group === group).map((s) => s.title);
    expect(of("canvas")).toEqual(["Canvas"]);
    expect(of("code")).toEqual(["CodeSpace"]);
    expect(of("chat")).toEqual(["Chat"]);
  });
});
