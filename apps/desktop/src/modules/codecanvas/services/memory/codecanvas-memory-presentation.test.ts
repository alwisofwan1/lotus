import { describe, expect, it } from "vitest";
import type { CodeCanvasMemoryItem } from "@/lib/tauri/codecanvas";
import {
  MEMORY_COMPOSE_KINDS,
  countMemoryKinds,
  describeMemoryActor,
  describeMemoryKind,
  describeMemoryScope,
  formatMemoryAge,
  groupMemoryItemsByKind,
  isMemoryPinned,
  memoryKindReachesAgents,
} from "./codecanvas-memory-presentation";

function item(overrides: Partial<CodeCanvasMemoryItem> = {}): CodeCanvasMemoryItem {
  return {
    id: "mem-1",
    projectId: "p1",
    scopeKind: "project",
    kind: "decision",
    body: "Store project memory as append-only rows.",
    importance: 5,
    tags: [],
    metadata: {},
    source: "human",
    actorKind: "human",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("memory kind presentation", () => {
  it("renames constraint to rule without touching the stored string", () => {
    const rule = describeMemoryKind("constraint");
    expect(rule.stored).toBe("constraint");
    expect(rule.label).toBe("Rule");
    expect(rule.reachesAgents).toBe(true);
  });

  it("labels external-context as imported and keeps it out of agent prompts", () => {
    const imported = describeMemoryKind("external-context");
    expect(imported.label).toBe("Imported");
    expect(imported.reachesAgents).toBe(false);
  });

  it("marks notes as human-only because PROMPT_KINDS excludes them", () => {
    expect(describeMemoryKind("note").reachesAgents).toBe(false);
    expect(memoryKindReachesAgents("note")).toBe(false);
    expect(memoryKindReachesAgents("constraint")).toBe(true);
    expect(memoryKindReachesAgents("evidence")).toBe(true);
  });

  it("falls back safely for kinds the UI does not know", () => {
    const unknown = describeMemoryKind("wildcard-kind");
    expect(unknown.stored).toBe("wildcard-kind");
    expect(unknown.label).toBe("wildcard-kind");
    expect(unknown.glyph).toBeTruthy();
    expect(unknown.colorRole).toBe("neutral");
    expect(unknown.reachesAgents).toBe(false);
  });

  it("gives every composable kind a distinct label and a teaching blurb", () => {
    const labels = MEMORY_COMPOSE_KINDS.map((kind) => describeMemoryKind(kind).label);
    expect(new Set(labels).size).toBe(MEMORY_COMPOSE_KINDS.length);
    for (const kind of MEMORY_COMPOSE_KINDS) {
      expect(describeMemoryKind(kind).blurb.length).toBeGreaterThan(10);
    }
  });
});

describe("memory provenance", () => {
  it("names the human as you and an agent by its actor id", () => {
    expect(describeMemoryActor(item({ source: "human", actorKind: "human" }))).toBe("you");
    expect(describeMemoryActor(item({ source: "agent", actorKind: "agent", actorId: "Rowan" }))).toBe("Rowan");
    expect(describeMemoryActor(item({ source: "agent", actorKind: "agent" }))).toBe("agent");
  });

  it("describes the narrowest scope the item carries", () => {
    expect(describeMemoryScope(item())).toBe("project-wide");
    expect(describeMemoryScope(item({ nodeId: "node-abcdef12" }))).toBe("node · node-abc");
    expect(describeMemoryScope(item({ nodeId: "node-abcdef12", runId: "run-99887766" }))).toBe("run · run-9988");
    expect(describeMemoryScope(item({ assignmentKey: "qa-pass" }))).toBe("assignment · qa-pass");
    expect(describeMemoryScope(item({ sessionId: "sess-1234567" }))).toBe("session · sess-123");
  });

  it("reads pinned from the store's pinned tag, not importance", () => {
    expect(isMemoryPinned(item({ tags: ["pinned", "git"] }))).toBe(true);
    expect(isMemoryPinned(item({ tags: ["git"], importance: 99 }))).toBe(false);
  });
});

describe("relative age", () => {
  const now = 10 * 86_400_000;

  it("compresses to the coarsest useful unit", () => {
    expect(formatMemoryAge(now, now)).toBe("now");
    expect(formatMemoryAge(now - 30_000, now)).toBe("now");
    expect(formatMemoryAge(now - 18 * 60_000, now)).toBe("18m");
    expect(formatMemoryAge(now - 2 * 3_600_000, now)).toBe("2h");
    expect(formatMemoryAge(now - 3 * 86_400_000, now)).toBe("3d");
    expect(formatMemoryAge(now - 21 * 86_400_000, now)).toBe("3w");
  });

  it("never renders a negative age for clock skew", () => {
    expect(formatMemoryAge(now + 60_000, now)).toBe("now");
  });
});

describe("grouping and counting", () => {
  const items = [
    item({ id: "s", kind: "summary" }),
    item({ id: "c1", kind: "constraint" }),
    item({ id: "n", kind: "note" }),
    item({ id: "d", kind: "decision" }),
    item({ id: "c2", kind: "constraint" }),
  ];

  it("orders groups by the read model's kind weight and keeps unknown kinds last", () => {
    const groups = groupMemoryItemsByKind([...items, item({ id: "x", kind: "mystery" })]);
    expect(groups.map((group) => group.kind)).toEqual([
      "constraint",
      "decision",
      "summary",
      "note",
      "mystery",
    ]);
    expect(groups[0].items.map((entry) => entry.id)).toEqual(["c1", "c2"]);
  });

  it("skips empty groups entirely", () => {
    const groups = groupMemoryItemsByKind([item({ kind: "note" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Notes");
  });

  it("counts per kind for the filter chips", () => {
    expect(countMemoryKinds(items)).toEqual({ summary: 1, constraint: 2, note: 1, decision: 1 });
  });
});
