import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { decideTaskFrame } from "../canvas-task-frame";

const agent = (id: string, frameId?: string): Node => ({
  id, type: "agent", position: { x: 0, y: 0 }, data: { ...(frameId ? { frameId } : {}) },
});
const frame = (id: string, title: string, taskKey?: string): Node => ({
  id, type: "frame", position: { x: 0, y: 0 }, data: { title, ...(taskKey ? { taskKey } : {}) },
});
const task = { id: "task_1", title: "Fix login" };

describe("decideTaskFrame", () => {
  it("does nothing without a task", () => {
    expect(decideTaskFrame({ nodes: [], task: undefined, pending: undefined })).toEqual({ kind: "none" });
    expect(decideTaskFrame({ nodes: [], task: { id: "  ", title: "x" }, pending: undefined })).toEqual({ kind: "none" });
  });

  it("first spawn for a task stays loose", () => {
    expect(decideTaskFrame({ nodes: [], task, pending: undefined })).toEqual({ kind: "loose" });
  });

  it("second spawn creates a Frame named after the task and pulls the first cell in", () => {
    const nodes = [agent("a1")];
    expect(decideTaskFrame({ nodes, task, pending: { looseNodeId: "a1", fresh: false } })).toEqual({
      kind: "create", title: "Fix login", taskKey: "task_1", pullNodeId: "a1",
    });
  });

  it("reuses the Frame that already carries the task key, whatever it is titled now", () => {
    const nodes = [frame("f1", "Renamed by user", "task_1"), agent("a1", "f1")];
    expect(decideTaskFrame({ nodes, task, pending: undefined })).toEqual({ kind: "reuse", frameId: "f1" });
  });

  it("reuse wins over a pending loose cell", () => {
    const nodes = [frame("f1", "T", "task_1"), agent("a1")];
    expect(decideTaskFrame({ nodes, task, pending: { looseNodeId: "a1", fresh: false } })).toEqual({ kind: "reuse", frameId: "f1" });
  });

  it("a first cell the user already moved into a Frame, or deleted, no longer counts as pending", () => {
    expect(decideTaskFrame({ nodes: [agent("a1", "fx"), frame("fx", "Other")], task, pending: { looseNodeId: "a1", fresh: false } })).toEqual({ kind: "loose" });
    expect(decideTaskFrame({ nodes: [], task, pending: { looseNodeId: "gone", fresh: false } })).toEqual({ kind: "loose" });
  });

  it("a Frame for another task is not reused", () => {
    const nodes = [frame("f1", "Other", "task_2")];
    expect(decideTaskFrame({ nodes, task, pending: undefined })).toEqual({ kind: "loose" });
  });

  it("falls back to the task id when the title is blank", () => {
    expect(decideTaskFrame({ nodes: [agent("a1")], task: { id: "task_1", title: " " }, pending: { looseNodeId: "a1", fresh: false } })).toMatchObject({ kind: "create", title: "task_1" });
  });

  describe("a spawn whose node the board has not rendered yet (parallel spawns)", () => {
    it("a just-spawned first cell missing from nodes still counts while fresh, not once stale", () => {
      expect(decideTaskFrame({ nodes: [], task, pending: { looseNodeId: "a1", fresh: true } }))
        .toMatchObject({ kind: "create", pullNodeId: "a1" });
      expect(decideTaskFrame({ nodes: [], task, pending: { looseNodeId: "a1", fresh: false } })).toEqual({ kind: "loose" });
    });

    it("a just-created Frame missing from nodes is reused while fresh, not once stale", () => {
      expect(decideTaskFrame({ nodes: [], task, pending: { frameId: "f9", fresh: true } })).toEqual({ kind: "reuse", frameId: "f9" });
      expect(decideTaskFrame({ nodes: [], task, pending: { frameId: "f9", fresh: false } })).toEqual({ kind: "loose" });
    });
  });
});
