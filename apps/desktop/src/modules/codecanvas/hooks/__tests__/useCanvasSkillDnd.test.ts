import { describe, it, expect } from "vitest";
import { resolveSkillDrop, SKILL_DRAG_PREFIX, TERM_DROP_PREFIX, AGENT_DROP_PREFIX } from "../useCanvasSkillDnd";

const skill = { name: "ship", source: "project" as const, content: "# Ship" };

describe("resolveSkillDrop", () => {
  it("resolves a skill dropped onto a terminal", () => {
    const r = resolveSkillDrop(`${SKILL_DRAG_PREFIX}ship`, `${TERM_DROP_PREFIX}term-1`, { skill });
    expect(r).toEqual({ kind: "skill-drop", targetKind: "terminal", targetId: "term-1", skillName: "ship", skill });
  });

  it("resolves a skill dropped onto an agent node", () => {
    const r = resolveSkillDrop(`${SKILL_DRAG_PREFIX}ship`, `${AGENT_DROP_PREFIX}agent-9`, { skill });
    expect(r).toEqual({ kind: "skill-drop", targetKind: "agent", targetId: "agent-9", skillName: "ship", skill });
  });

  it("returns none when dropped on empty canvas (no over target)", () => {
    expect(resolveSkillDrop(`${SKILL_DRAG_PREFIX}ship`, null, { skill }).kind).toBe("none");
  });

  it("returns none when the over target is not a terminal", () => {
    expect(resolveSkillDrop(`${SKILL_DRAG_PREFIX}ship`, "note:note-1", { skill }).kind).toBe("none");
  });

  it("returns none when the active item is not a skill", () => {
    expect(resolveSkillDrop("task:t1", `${TERM_DROP_PREFIX}term-1`, { skill }).kind).toBe("none");
  });

  it("returns none when drag data carries no skill", () => {
    expect(resolveSkillDrop(`${SKILL_DRAG_PREFIX}ship`, `${TERM_DROP_PREFIX}term-1`, undefined).kind).toBe("none");
  });
});
