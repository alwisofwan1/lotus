import { describe, expect, it } from "vitest";
import { deleteDecision } from "../session-delete";
import type { CanvasSessionRecord } from "../session-record";

function session(overrides: Partial<CanvasSessionRecord> = {}): CanvasSessionRecord {
  return {
    id: "sess-1",
    projectId: "cp_1",
    nodeId: "agent-1",
    runner: "claude",
    status: "resumable",
    title: "Probe · baris hantu",
    createdAt: 0,
    lastActivityAt: 0,
    ...overrides,
  } as CanvasSessionRecord;
}

describe("deleteDecision", () => {
  it("allows deleting a stored conversation", () => {
    expect(deleteDecision(session())).toEqual({ allowed: true });
  });

  // Deleting the record while the CLI is still running would make the list lie: the process is
  // still holding memory and still reachable, and Lotus would have forgotten it exists.
  it("refuses a running conversation, and says what to do first", () => {
    const verdict = deleteDecision(session({ status: "live" }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.text).toBe(
      "Stop the agent before deleting this session.",
    );
  });

  it("allows deleting one the runner has lost", () => {
    expect(deleteDecision(session({ status: "dead" }))).toEqual({ allowed: true });
  });
});
