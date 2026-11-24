import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { deriveSkillPreviewFocusChain, uniqueCanvasFocusIds } from "../canvas-focus-chain";

describe("canvas-focus-chain", () => {
  it("deduplicates ids while preserving visual chain order", () => {
    expect(uniqueCanvasFocusIds(["term-1", "skills-1", "skills-1", null, "skill-1"])).toEqual([
      "term-1",
      "skills-1",
      "skill-1",
    ]);
  });

  it("fits Terminal → Skills → Skill detail for skill preview focus", () => {
    const edges: Edge[] = [
      { id: "e1", source: "term-1", target: "skills-1" },
      { id: "e2", source: "skills-1", target: "skill-1" },
    ];

    expect(deriveSkillPreviewFocusChain(edges, "skills-1", "skill-1")).toEqual([
      "term-1",
      "skills-1",
      "skill-1",
    ]);
  });

  it("falls back to Skills → Skill detail when the terminal edge is unavailable", () => {
    expect(deriveSkillPreviewFocusChain([], "skills-1", "skill-1")).toEqual(["skills-1", "skill-1"]);
  });
});
