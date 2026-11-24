import { describe, expect, it } from "vitest";
import { mergeContextArtifacts, projectMemoryAsContextArtifacts } from "./codecanvas-memory-context-projection";
import type { CodeCanvasMemoryItem } from "@/lib/tauri/codecanvas";
import type { ContextArtifact } from "../context-bus-record";

function mem(overrides: Partial<CodeCanvasMemoryItem> = {}): CodeCanvasMemoryItem {
  return {
    id: "m1",
    projectId: "p1",
    scopeKind: "project",
    kind: "note",
    body: "body text",
    importance: 0,
    tags: [],
    metadata: {},
    source: "mcp",
    actorKind: "agent",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function busArtifact(overrides: Partial<ContextArtifact> = {}): ContextArtifact {
  return {
    id: "art1",
    projectId: "p1",
    busNodeId: "bus-1",
    key: "Rowan",
    value: "run output",
    producer: "Rowan",
    version: 1,
    graphRunId: null,
    updatedAt: 5,
    ...overrides,
  };
}

describe("projectMemoryAsContextArtifacts", () => {
  it("projects durable kinds and skips chatter and archived rows", () => {
    const items = [
      mem({ id: "a", kind: "decision", title: "Use SQLite", updatedAt: 3 }),
      mem({ id: "b", kind: "status", body: "running", updatedAt: 2 }),
      mem({ id: "c", kind: "artifact", body: "out", updatedAt: 1, archivedAt: 9 }),
      mem({ id: "d", kind: "external-context", body: "from claude", source: "claude", updatedAt: 4 }),
    ];
    const projected = projectMemoryAsContextArtifacts(items, "bus-1");
    expect(projected.map((p) => p.id)).toEqual(["mem:a", "mem:d"]);
    expect(projected[0].busNodeId).toBe("bus-1");
    expect(projected[0].key).toBe("Use SQLite");
    expect(projected[1].producer).toBe("claude");
  });

  it("uses summary over body and falls back to a readable key", () => {
    const projected = projectMemoryAsContextArtifacts(
      [mem({ id: "abcdef123456", kind: "artifact", summary: "short", body: "long body" })],
      "bus-1",
    );
    expect(projected[0].value).toBe("short");
    expect(projected[0].key).toBe("artifact:123456");
  });
});

describe("mergeContextArtifacts", () => {
  it("keeps bus artifacts first and appends projected memory without key collisions", () => {
    const bus = [busArtifact({ key: "Rowan" })];
    const projected = [
      projectMemoryAsContextArtifacts([mem({ id: "x", kind: "decision", title: "Rowan" })], "bus-1")[0],
      projectMemoryAsContextArtifacts([mem({ id: "y", kind: "decision", title: "Use SQLite" })], "bus-1")[0],
    ];
    const merged = mergeContextArtifacts(bus, projected);
    expect(merged.map((m) => m.id)).toEqual(["art1", "mem:y"]);
  });
});
