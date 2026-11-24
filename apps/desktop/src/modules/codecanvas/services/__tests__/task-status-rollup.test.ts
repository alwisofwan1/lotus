import { describe, it, expect } from "vitest";
import { rollUpTaskStatus } from "../task-status-rollup";
import type { AgentStatusSnapshot } from "../agent-status-registry";

function snap(id: string, status: AgentStatusSnapshot["status"]): AgentStatusSnapshot {
  return { id, name: id, status };
}

describe("rollUpTaskStatus", () => {
  it("returns null when the task has no dispatched agents", () => {
    expect(rollUpTaskStatus([], [], "todo")).toBeNull();
  });

  it("returns null when none of the dispatched agents are in the roster yet", () => {
    expect(rollUpTaskStatus(["a"], [snap("other", "running")], "todo")).toBeNull();
  });

  it("moves a todo task to in-progress once an agent is running", () => {
    expect(rollUpTaskStatus(["a", "b"], [snap("a", "running"), snap("b", "idle")], "todo")).toBe("in-progress");
  });

  it("moves to in-review once every dispatched agent has completed", () => {
    expect(rollUpTaskStatus(["a", "b"], [snap("a", "completed"), snap("b", "completed")], "in-progress")).toBe("in-review");
  });

  it("treats an errored agent as terminal for the all-done check", () => {
    expect(rollUpTaskStatus(["a", "b"], [snap("a", "completed"), snap("b", "error")], "in-progress")).toBe("in-review");
  });

  it("leaves a blocked task blocked when its agents finish — a FAIL verdict is not undone by the run ending", () => {
    expect(rollUpTaskStatus(["a"], [snap("a", "completed")], "blocked")).toBeNull();
  });

  it("does not regress a task already in-review or complete", () => {
    const done = [snap("a", "completed")];
    expect(rollUpTaskStatus(["a"], done, "in-review")).toBeNull();
    expect(rollUpTaskStatus(["a"], done, "complete")).toBeNull();
  });

  it("returns null while agents are still running and the task already shows in-progress", () => {
    expect(rollUpTaskStatus(["a", "b"], [snap("a", "running"), snap("b", "completed")], "in-progress")).toBeNull();
  });
});
