import { describe, expect, it } from "vitest";
import { resolveOwnerName, resolveStepAgentId, type AgentRef } from "../plan-owner";

const TEAM = ["Tech Lead", "Backend Engineer", "Frontend Engineer", "QA / Test Engineer"];

const ROSTER: AgentRef[] = [
  { id: "tl", name: "Tech Lead" },
  { id: "be", name: "Backend Engineer" },
  { id: "fe", name: "Frontend Engineer" },
];

describe("resolveOwnerName", () => {
  it("matches an exact name (case-insensitively)", () => {
    expect(resolveOwnerName("Backend Engineer", TEAM)).toBe("Backend Engineer");
    expect(resolveOwnerName("backend engineer", TEAM)).toBe("Backend Engineer");
  });

  it("matches a short owner to the full agent name it prefixes", () => {
    expect(resolveOwnerName("Backend", TEAM)).toBe("Backend Engineer");
    expect(resolveOwnerName("Frontend", TEAM)).toBe("Frontend Engineer");
    expect(resolveOwnerName("QA", TEAM)).toBe("QA / Test Engineer");
  });

  it("matches a long owner whose first words name a shorter agent", () => {
    expect(resolveOwnerName("Backend Specialist", ["Backend", "Frontend"])).toBe("Backend");
  });

  it("refuses ambiguous matches instead of guessing", () => {
    expect(resolveOwnerName("Backend", ["Backend Engineer", "Backend Architect"])).toBeUndefined();
  });

  it("returns undefined for no match or empty owner", () => {
    expect(resolveOwnerName("Ghost", TEAM)).toBeUndefined();
    expect(resolveOwnerName("", TEAM)).toBeUndefined();
    expect(resolveOwnerName(undefined, TEAM)).toBeUndefined();
  });

  it("prefers an exact match over a prefix match", () => {
    expect(resolveOwnerName("Backend", ["Backend", "Backend Engineer"])).toBe("Backend");
  });
});

describe("resolveStepAgentId", () => {
  it("resolves a short owner to the matching agent's node id", () => {
    expect(resolveStepAgentId("Backend", ROSTER)).toBe("be");
    expect(resolveStepAgentId("Frontend", ROSTER)).toBe("fe");
  });

  it("honors a manual binding over name resolution (survives a rename)", () => {
    // Agent "be" was renamed to "BE"; the plan still says owner "Backend", but the binding holds.
    const renamed: AgentRef[] = [{ id: "be", name: "BE" }, { id: "fe", name: "Frontend Engineer" }];
    expect(resolveStepAgentId("Backend", renamed)).toBeUndefined(); // name no longer resolves
    expect(resolveStepAgentId("Backend", renamed, { Backend: "be" })).toBe("be"); // binding does
  });

  it("ignores a stale binding whose agent no longer exists, falling back to name", () => {
    expect(resolveStepAgentId("Backend", ROSTER, { Backend: "ghost" })).toBe("be");
  });

  it("returns undefined for an unownable step", () => {
    expect(resolveStepAgentId(undefined, ROSTER)).toBeUndefined();
    expect(resolveStepAgentId("Nobody", ROSTER)).toBeUndefined();
  });
});
