import { describe, expect, it } from "vitest";

import { gatingFor } from "../gating.js";

/**
 * ADR-8: a cell's posture is fixed for its life, so what the fleet reports about it must be
 * what was actually launched. `issues/03` found the gap this closes — `claude.ts` wrote
 * `--dangerously-skip-permissions` unconditionally while `toFleetMember` never set `gating`,
 * so opening `spawn` would have shown the phone a permission posture the machine ignores.
 */
describe("gatingFor", () => {
  /**
   * Nothing chosen means nothing known. This answered `asks` until 2026-09-06, on the reasoning
   * that claude with no flag asks per action — then a cell spawned that way came up
   * `⏵⏵ auto mode on` on devbox-vps, because the effective mode can come from state this host
   * cannot see. Absence already means *unknown* in `FleetMember.gating`, never *ungated*.
   */
  it("says nothing about a cell nobody chose a posture for", () => {
    expect(gatingFor("claude", undefined)).toBeUndefined();
  });

  it("says a claude cell asks when manual was actually chosen", () => {
    expect(gatingFor("claude", "manual")).toBe("asks");
  });

  it("keeps asking for the modes that only widen what may be edited", () => {
    // `acceptEdits` writes files on its own and still asks for everything else; `plan`
    // may change nothing at all. Neither is the gate being off.
    expect(gatingFor("claude", "acceptEdits")).toBe("asks");
    expect(gatingFor("claude", "plan")).toBe("asks");
  });

  it("says skipped only for the one mode that turns the gate off", () => {
    expect(gatingFor("claude", "bypassPermissions")).toBe("skipped");
    expect(gatingFor("claude", "yolo")).toBe("skipped");
  });

  /**
   * Not "skipped" — that would read as a choice somebody made and could unmake by
   * respawning. A terminal Codex has no hook mechanism to ask through at all, which is a
   * fact about the runner (`FleetMember.gating`).
   */
  it("says a terminal codex cannot ask, rather than that it was told not to", () => {
    expect(gatingFor("codex", undefined)).toBe("runner_cannot");
    expect(gatingFor("codex", "read-only")).toBe("runner_cannot");
  });

  /**
   * Absent means unknown, never ungated. A custom runner's command is arbitrary, and
   * understating risk is the one error worth avoiding here.
   */
  it("says nothing at all about a runner it does not know", () => {
    expect(gatingFor("ccs", undefined)).toBeUndefined();
    expect(gatingFor("some-custom-runner", "manual")).toBeUndefined();
  });
});
