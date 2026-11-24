import { describe, expect, it } from "vitest";
import { runnerTurnCapability } from "../runner-capability";

describe("runnerTurnCapability", () => {
  it("gives the Claude family both capabilities", () => {
    expect(runnerTurnCapability("claude")).toEqual({ reportsTurnEnd: true, reportsSteps: true });
  });

  it("gives Codex both — its hooks.json has reported per-step events since 2026-08-13", () => {
    // Was `reportsSteps: false` while Codex's only surface was one `agent-turn-complete`
    // notify. `codex_hooks.rs` changed the facts; this stayed stale for two weeks.
    expect(runnerTurnCapability("codex")).toEqual({ reportsTurnEnd: true, reportsSteps: true });
  });

  it("gives Cursor steps but no turn end — the Claude-format tool hooks fire under it, Stop does not", () => {
    expect(runnerTurnCapability("cursor")).toEqual({ reportsTurnEnd: false, reportsSteps: true });
  });

  it("treats a custom runner wrapping a second Claude account as the Claude family", () => {
    // Such a runner fires the same global hooks, so it reports everything Claude does.
    expect(runnerTurnCapability("custom", true)).toEqual({
      reportsTurnEnd: true,
      reportsSteps: true,
    });
  });

  it("claims nothing for a custom runner that is not Claude-family", () => {
    // An arbitrary command. Unknown capability must not license trusting a fact — understating is
    // the one error worth making here, and it lands the pane on today's PTY behaviour.
    expect(runnerTurnCapability("custom")).toEqual({ reportsTurnEnd: false, reportsSteps: false });
  });

  it("claims nothing for a runner that has not reported itself yet", () => {
    // `undefined` means "the frontend has not said". The fleet contract reads an absent capability
    // as "this host cannot say"; the resolver must read it the same way rather than assuming.
    expect(runnerTurnCapability(undefined)).toEqual({
      reportsTurnEnd: false,
      reportsSteps: false,
    });
  });
});
