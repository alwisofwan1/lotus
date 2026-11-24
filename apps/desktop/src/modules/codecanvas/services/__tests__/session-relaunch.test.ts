import { describe, expect, it } from "vitest";
import type { CanvasSessionRecord, CanvasSessionStatus } from "../session-record";
import { judgeRelaunch } from "../session-relaunch";

function session(status: CanvasSessionStatus = "resumable", id = "s1"): CanvasSessionRecord {
  return {
    id,
    projectId: "cp_1",
    nodeId: "agent-1",
    runner: "claude",
    cwd: "/repos/demo",
    title: "Transcript route",
    status,
    origin: "manual",
    turnCount: 4,
    lastActivityAt: 1_000,
    createdAt: 1_000,
  };
}

const facts = { projectId: "cp_1" };

describe("judgeRelaunch", () => {
  it("allows resuming a saved conversation", () => {
    const verdict = judgeRelaunch({ kind: "resume", session: session() }, facts);
    expect(verdict).toEqual({ allowed: true, intent: { kind: "resume", session: session() } });
  });

  it("allows starting a fresh conversation on the same node", () => {
    expect(judgeRelaunch({ kind: "new" }, facts).allowed).toBe(true);
  });

  // Killing a healthy CLI to start an identical one is pure loss; the caller should focus instead.
  it("refuses to re-enter the conversation the node is already having", () => {
    const active = session("live", "s1");
    const verdict = judgeRelaunch(
      { kind: "resume", session: active },
      { ...facts, activeSessionId: "s1" },
    );
    expect(verdict).toEqual({ allowed: false, reason: "already-active" });
  });

  // Resuming a session the CLI has lost drops the user into a bare pane, which reads as destruction.
  it("refuses a conversation the CLI no longer knows", () => {
    const verdict = judgeRelaunch({ kind: "resume", session: session("dead") }, facts);
    expect(verdict).toEqual({ allowed: false, reason: "dead-session" });
  });

  it("refuses anything without a project", () => {
    expect(judgeRelaunch({ kind: "new" }, { projectId: null })).toEqual({
      allowed: false,
      reason: "no-project",
    });
  });

  // The pane is mid-question. Relaunching throws away a turn waiting on a human, and only that
  // human knows whether it matters — so it is allowed, but never silently.
  it("asks first when the pane is waiting on an answer", () => {
    const verdict = judgeRelaunch({ kind: "new" }, { ...facts, awaitingAnswer: true });
    expect(verdict).toEqual({ allowed: true, intent: { kind: "new" }, confirm: "needs-you" });
  });

  it("still refuses outright cases even while awaiting an answer", () => {
    const verdict = judgeRelaunch(
      { kind: "resume", session: session("dead") },
      { ...facts, awaitingAnswer: true },
    );
    expect(verdict).toEqual({ allowed: false, reason: "dead-session" });
  });

  it("allows resuming a different session while another is active", () => {
    const verdict = judgeRelaunch(
      { kind: "resume", session: session("resumable", "s2") },
      { ...facts, activeSessionId: "s1" },
    );
    expect(verdict.allowed).toBe(true);
  });

  // A runner with no resume mechanism still gets a fresh process seeded with context; that is a
  // "restart", and the judgement layer must not block it.
  it("allows relaunching a no-resume session", () => {
    expect(judgeRelaunch({ kind: "resume", session: session("no-resume") }, facts).allowed).toBe(true);
  });
});
