import { describe, expect, it } from "vitest";
import { shouldPublishStalled } from "../stalled-guard";
import type { AgentTurnFact } from "../agent-turn-registry";

const fact = (turn: string): AgentTurnFact => ({ paneId: "p-1", turn, atMs: 0 });

describe("shouldPublishStalled", () => {
  it("still marks a hook-less pane stalled after the quiet window", () => {
    // `cursor`, a non-claude custom command: byte silence is the only liveness signal there is, so
    // today's behaviour must survive untouched.
    expect(shouldPublishStalled({ fact: undefined })).toBe(true);
  });

  it("marks a pane stalled when the hook last said it was working", () => {
    // Mid-turn and silent for 30s is genuinely suspicious — a hung tool call, a deadlocked TUI.
    // This is the case RC-2 was written for and it keeps working.
    expect(shouldPublishStalled({ fact: fact("running") })).toBe(true);
  });

  it("never marks a pane stalled while it is waiting for a human", () => {
    // The bug this guard exists for. A blocked agent emits NO bytes — that is what being blocked
    // means — so RC-2 fired 30s after `needs-you` appeared and overwrote it with `stalled`,
    // emptying the lane and leaving mod+J with nowhere to jump. Silence here is the expected
    // state, for as long as the human takes.
    expect(shouldPublishStalled({ fact: fact("needs-input") })).toBe(false);
  });

  it("never marks a pane stalled when the hook said the turn ended", () => {
    // Settled at the prompt is not unresponsive. Publishing `stalled` over a hook-reported `idle`
    // is the false-"working" family in reverse: a healthy agent reported as sick.
    expect(shouldPublishStalled({ fact: fact("idle") })).toBe(false);
    expect(shouldPublishStalled({ fact: fact("ended") })).toBe(false);
  });

  it("leaves a hook-reported failure alone rather than relabelling it stalled", () => {
    // `error` is more specific than `stalled` and the hook is the one that knows.
    expect(shouldPublishStalled({ fact: fact("error") })).toBe(false);
  });

  it("falls back to the byte heuristic for a turn value it does not recognise", () => {
    // The wire vocabulary can grow without a desktop rebuild. An unknown value is not a licence to
    // suppress the only liveness signal available, so the guard defers rather than assuming safety.
    expect(shouldPublishStalled({ fact: fact("compacting") })).toBe(true);
  });

  it("does not call a pane hung when the human acted after its last fact", () => {
    // The escalation observed live 2026-08-25: rejecting a tool ended the turn with no hook, the
    // last fact stayed `running`, and 30s later this guard let RC-2 publish `stalled` — by its own
    // rule, correctly, since `running` + silence is exactly the hang it watches for.
    //
    // A human action is a turn boundary. A `running` fact older than one describes the past, so the
    // silence after it is expected rather than suspicious.
    expect(
      shouldPublishStalled({ fact: { ...fact("running"), atMs: 1_000 }, answeredAtMs: 5_000 }),
    ).toBe(false);
  });

  it("still calls a pane hung when its work started after the human acted", () => {
    // The genuine hang: the human sent something, the agent began, and then went silent.
    expect(
      shouldPublishStalled({ fact: { ...fact("running"), atMs: 9_000 }, answeredAtMs: 5_000 }),
    ).toBe(true);
  });

  it("ignores the mark for a pane no hook has spoken for", () => {
    // Nothing to be older than, and bytes are the only signal such a runner has.
    expect(shouldPublishStalled({ fact: undefined, answeredAtMs: 5_000 })).toBe(true);
  });
});
