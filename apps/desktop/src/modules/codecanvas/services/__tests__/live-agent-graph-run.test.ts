import { describe, it, expect } from "vitest";
import { buildLiveRunMessage, liveRunTurnOutcome, type LiveRunTurnInput } from "../live-agent-graph-run";

describe("buildLiveRunMessage", () => {
  it("states the run, the goal and the step, on one line", () => {
    const msg = buildLiveRunMessage({ runTitle: "Ship auth", brief: "Add login rate limit", agentName: "Atlas", upstream: [] });
    expect(msg).toContain('[Lotus run "Ship auth"] Atlas, this is your step.');
    expect(msg).toContain("Goal: Add login rate limit. Do your part");
    expect(msg).toContain("end your turn");
    expect(msg).not.toContain("\n");
  });

  it("names upstream agents and carries their summaries, clipped", () => {
    const long = "x".repeat(2000);
    const msg = buildLiveRunMessage({
      runTitle: "R", brief: "G", agentName: "Lyra",
      upstream: [{ name: "Atlas", summary: "Tests pass" }, { name: "Kai", summary: long }, { name: "Mo" }],
    });
    expect(msg).toContain("Done before you: Atlas, Kai, Mo.");
    expect(msg).toContain("Atlas reported: Tests pass");
    expect(msg).toContain(`Kai reported: ${"x".repeat(1200)}…`);
    expect(msg).not.toContain("Mo reported");
    expect(msg).toContain("lotus_read_cell_output");
  });
});

describe("liveRunTurnOutcome", () => {
  const base: LiveRunTurnInput = { submittedAtMs: 1_000, fact: undefined, reportsTurnEnd: true, status: "running", ptyEnded: false, sawBusy: false };
  const fact = (turn: string, atMs: number) => ({ paneId: "p", turn, atMs });

  it("ignores a fact from before the submit (the previous turn)", () => {
    expect(liveRunTurnOutcome({ ...base, fact: fact("idle", 999) })).toBe("pending");
  });

  it("is done on a hook idle or ended after the submit", () => {
    expect(liveRunTurnOutcome({ ...base, fact: fact("idle", 2_000) })).toBe("completed");
    expect(liveRunTurnOutcome({ ...base, fact: fact("ended", 2_000) })).toBe("completed");
  });

  it("keeps waiting while running or while the agent needs a human", () => {
    expect(liveRunTurnOutcome({ ...base, fact: fact("running", 2_000) })).toBe("pending");
    expect(liveRunTurnOutcome({ ...base, fact: fact("needs-input", 2_000), status: "needs-you" })).toBe("pending");
  });

  it("fails on a hook error, an error status, or a dead terminal", () => {
    expect(liveRunTurnOutcome({ ...base, fact: fact("error", 2_000) })).toBe("error");
    expect(liveRunTurnOutcome({ ...base, status: "error" })).toBe("error");
    expect(liveRunTurnOutcome({ ...base, ptyEnded: true })).toBe("error");
  });

  it("uses the byte-idle stall for runners with no turn-end hook", () => {
    const quiet = { ...base, reportsTurnEnd: false };
    expect(liveRunTurnOutcome({ ...quiet, fact: fact("idle", 2_000) })).toBe("pending");
    expect(liveRunTurnOutcome({ ...quiet, status: "stalled" })).toBe("pending"); // stall left from an old turn
    expect(liveRunTurnOutcome({ ...quiet, status: "stalled", sawBusy: true })).toBe("completed");
  });
});
