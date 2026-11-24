import { describe, expect, it } from "vitest";
import { buildArtifact, isStale, nextVersion } from "../context-bus-record";

describe("context-bus-record", () => {
  it("builds an artifact at version 1 with the given fields", () => {
    const a = buildArtifact({
      projectId: "p1", busNodeId: "bus-1", key: "Architect",
      value: "the schema", producer: "Architect", graphRunId: "run-1", now: 100,
    });
    expect(a).toMatchObject({
      projectId: "p1", busNodeId: "bus-1", key: "Architect",
      value: "the schema", producer: "Architect", version: 1, graphRunId: "run-1", updatedAt: 100,
    });
    expect(a.id).toBeTruthy();
  });

  it("bumps version off the previous artifact when overwriting the same key", () => {
    const v1 = buildArtifact({ projectId: "p", busNodeId: "b", key: "k", value: "x", producer: "A", graphRunId: null, now: 1 });
    const v2 = buildArtifact({
      projectId: "p", busNodeId: "b", key: "k", value: "y", producer: "A", graphRunId: null, now: 2,
      version: nextVersion(v1),
    });
    expect(v2.version).toBe(2);
  });

  it("nextVersion treats null/undefined as a fresh artifact", () => {
    expect(nextVersion(null)).toBe(1);
    expect(nextVersion({ version: 4 })).toBe(5);
  });

  it("flags an artifact stale only when its run differs from the active run", () => {
    const a = buildArtifact({ projectId: "p", busNodeId: "b", key: "k", value: "v", producer: "A", graphRunId: "run-1", now: 1 });
    expect(isStale(a, "run-2")).toBe(true);   // produced in an earlier run
    expect(isStale(a, "run-1")).toBe(false);  // same run
    expect(isStale(a, null)).toBe(false);     // no active run → cannot judge, don't warn
    const manual = buildArtifact({ projectId: "p", busNodeId: "b", key: "k", value: "v", producer: "A", graphRunId: null, now: 1 });
    expect(isStale(manual, "run-1")).toBe(false); // artifact has no run tag → don't warn
  });
});
