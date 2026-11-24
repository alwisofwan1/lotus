import { describe, it, expect } from "vitest";
import { INITIAL_AGENT_STATE, agentStatusReducer } from "../agent-status";

describe("agentStatusReducer", () => {
  it("moves to running and records the session id on a session event", () => {
    const next = agentStatusReducer(INITIAL_AGENT_STATE, { kind: "session", sessionId: "s1" });
    expect(next).toEqual({ status: "running", sessionId: "s1" });
  });

  it("stays running on text and tool events", () => {
    expect(agentStatusReducer(INITIAL_AGENT_STATE, { kind: "text", text: "Analyzing" }).status).toBe("running");
    expect(agentStatusReducer(INITIAL_AGENT_STATE, { kind: "tool", label: "Reading a.ts" }).status).toBe("running");
  });

  it("completes on a successful result", () => {
    const next = agentStatusReducer(INITIAL_AGENT_STATE, { kind: "result", ok: true, text: "done" });
    expect(next.status).toBe("completed");
  });

  it("errors on a failed result", () => {
    const next = agentStatusReducer(INITIAL_AGENT_STATE, { kind: "result", ok: false, text: "boom" });
    expect(next.status).toBe("error");
  });

  it("completes on a clean exit when still running", () => {
    const running = agentStatusReducer(INITIAL_AGENT_STATE, { kind: "session", sessionId: "s1" });
    expect(agentStatusReducer(running, { kind: "exit", code: 0 }).status).toBe("completed");
  });

  it("errors on a non-zero exit when still running", () => {
    const running = agentStatusReducer(INITIAL_AGENT_STATE, { kind: "session", sessionId: "s1" });
    expect(agentStatusReducer(running, { kind: "exit", code: 1 }).status).toBe("error");
  });

  it("keeps a terminal status when a later exit arrives", () => {
    const done = agentStatusReducer(INITIAL_AGENT_STATE, { kind: "result", ok: true });
    expect(agentStatusReducer(done, { kind: "exit", code: 1 }).status).toBe("completed");
  });
});
