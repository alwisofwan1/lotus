import { describe, expect, it } from "vitest";
import { buildSessionRecord } from "../session-record";

// A custom runner's command is the one thing the type cannot carry: grok, opencode and a
// second-account Claude all arrive as the word `custom`. Without it, a node rebuilt from this row
// has nothing to launch — which is how "pasang" threw on 2026-09-12.
describe("a custom runner's command", () => {
  it("travels with the session that was started by it", () => {
    const record = buildSessionRecord({
      projectId: "cp_1",
      nodeId: "agent-1",
      runner: "custom",
      runnerCommand: "ccs acme",
      cwd: "/repos/demo",
      now: 10,
    });
    expect(record.runnerCommand).toBe("ccs acme");
  });

  it("stays absent for a built-in runner, which needs no command", () => {
    const record = buildSessionRecord({
      projectId: "cp_1",
      nodeId: "agent-1",
      runner: "claude",
      cwd: "/repos/demo",
      now: 10,
    });
    expect(record.runnerCommand ?? null).toBeNull();
  });
});
