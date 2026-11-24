import { describe, expect, it } from "vitest";
import { liveAgentPresentation } from "../live-agent-presentation";

const NOW = 1_000_000;

/** A connected Claude-family pane whose launch controller has reached `ready`. */
function atThePrompt(overrides: Partial<Parameters<typeof liveAgentPresentation>[0]> = {}) {
  return liveAgentPresentation({
    phase: "ready",
    ptyEnded: false,
    ptyError: false,
    fact: undefined,
    capability: { reportsTurnEnd: true, reportsSteps: true },
    now: NOW,
    ...overrides,
  });
}

describe("liveAgentPresentation", () => {
  /**
   * Invariant 1, corrected (2026-08-27).
   *
   * It used to read: "`ready` has always published as `running`; with no hook fact it still does."
   * That is the false-"working" state `TONE_TO_STATUS` documents and this resolver exists to fix,
   * and leaving it standing for the no-fact case meant an agent nobody had ever used reported
   * itself busy for as long as it lived. Seen live: three agents spawned five minutes earlier,
   * never given a task, all reading `working · 5m` in the Fleet rail.
   *
   * The line between the two cases below is the runner's own capability, not a guess about time.
   */
  it("reports idle at the prompt when the runner would have announced a turn by hook", () => {
    // A step-reporting runner fires `UserPromptSubmit` the instant work begins, so the worst this
    // can cost is a flicker — the same trade-off `agent-status-resolve.ts` already states for a
    // pane whose fact a human superseded.
    expect(atThePrompt()).toEqual({ status: "idle", tone: "idle" });
  });

  it("leaves a step-silent runner on the PTY's guess, where bytes are the only signal", () => {
    // No hook will ever describe a mid-turn state here, so `running` stays the honest answer:
    // calling this pane idle would hide an agent that really is working, with nothing to correct it.
    expect(atThePrompt({ capability: { reportsTurnEnd: true, reportsSteps: false } }))
      .toEqual({ status: "running", tone: "ready" });
  });

  it("reports needs-you and a matching tone when the hook says a human is needed", () => {
    // The tone must change too. Publishing `needs-you` while the header still renders `run` would
    // fix the fleet and leave the operator looking at the same white "working" badge.
    expect(
      atThePrompt({ fact: { paneId: "p-1", turn: "needs-input", atMs: NOW } }),
    ).toEqual({ status: "needs-you", tone: "needs-you" });
  });

  it("drops to idle when the hook says the turn ended, without touching the PTY", () => {
    expect(atThePrompt({ fact: { paneId: "p-1", turn: "idle", atMs: NOW } })).toEqual({
      status: "idle",
      tone: "idle",
    });
  });

  it("lets a dead PTY override a blocked agent's last word", () => {
    expect(
      atThePrompt({
        ptyError: true,
        fact: { paneId: "p-1", turn: "needs-input", atMs: NOW },
      }),
    ).toEqual({ status: "error", tone: "error" });
  });

  it("keeps a booting pane on its launch tone regardless of stale facts", () => {
    // `starting` is a launch-phase truth the hook stream knows nothing about.
    expect(
      liveAgentPresentation({
        phase: "awaiting-ready",
        ptyEnded: false,
        ptyError: false,
        fact: { paneId: "p-1", turn: "idle", atMs: NOW },
        capability: { reportsTurnEnd: true, reportsSteps: true },
        now: NOW,
      }),
    ).toEqual({ status: "connecting", tone: "starting" });
  });

  it("settles to idle once the human has answered, not back to the PTY guess", () => {
    // Card and lane read the same seam, so the badge and the triage row clear together — a rejected
    // prompt must not leave one of them still lit.
    //
    // `idle`, not `ready`/`running`: the launch tone for a settled pane maps to `running` on
    // purpose, as the INPUT the resolver corrects. Landing back on it after answering would
    // reinstate the false-"working" state permanently, since the rejection path sends no further
    // hook. Observed live 2026-08-25 as an 80-second `running`, then `stalled`.
    expect(
      atThePrompt({
        fact: { paneId: "p-1", turn: "needs-input", atMs: NOW - 30_000 },
        answeredAtMs: NOW - 10_000,
      }),
    ).toEqual({ status: "idle", tone: "idle" });
  });

  it("settles a stale running fact to idle too, which is the case the operator hit", () => {
    // The second live run: Notification never fired (rejected too quickly), so the stuck fact was
    // `running` rather than `needs-input`. Same principle, and it must cover both.
    expect(
      atThePrompt({
        fact: { paneId: "p-1", turn: "running", atMs: NOW - 80_000 },
        answeredAtMs: NOW - 60_000,
      }),
    ).toEqual({ status: "idle", tone: "idle" });
  });

  it("keeps needs-you for an ask raised after the human last acted", () => {
    expect(
      atThePrompt({
        fact: { paneId: "p-1", turn: "needs-input", atMs: NOW - 1_000 },
        answeredAtMs: NOW - 60_000,
      }),
    ).toEqual({ status: "needs-you", tone: "needs-you" });
  });
});
