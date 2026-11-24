import { describe, expect, it } from "vitest";

import { codexTurnInput } from "../codex-session";

const skills = [{ name: "lotus-probe", path: "/r/.agents/skills/lotus-probe/SKILL.md" }];
const skill = { type: "skill", name: "lotus-probe", path: "/r/.agents/skills/lotus-probe/SKILL.md" };

describe("codexTurnInput", () => {
  it("sends a leading known skill as structured input, the rest as text", () => {
    expect(codexTurnInput("/lotus-probe banana\nsplit", [], skills)).toEqual([
      { type: "text", text: "banana\nsplit", text_elements: [] },
      skill,
    ]);
    expect(codexTurnInput("/lotus-probe", [], skills)).toEqual([skill]);
  });

  it("keeps unknown names and mid-text slashes as plain text", () => {
    expect(codexTurnInput("/nope x", [], skills)).toEqual([{ type: "text", text: "/nope x", text_elements: [] }]);
    expect(codexTurnInput("run /lotus-probe", [], skills)).toEqual([{ type: "text", text: "run /lotus-probe", text_elements: [] }]);
  });
});
