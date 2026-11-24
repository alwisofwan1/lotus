import { describe, expect, it } from "vitest";
import { resolveAgentStatus, TURN_FRESH_MS } from "../agent-status-resolve";

const NOW = 1_000_000;

/** A step-reporting, turn-end-reporting runner (the Claude family) sitting at a live PTY. */
function claudeFamily(turn: string, ageMs = 0) {
  return {
    inferred: "running" as const,
    fact: { paneId: "p-1", turn, atMs: NOW - ageMs },
    reportsTurnEnd: true,
    reportsSteps: true,
    now: NOW,
  };
}

describe("resolveAgentStatus", () => {
  it("reports idle when the hook says idle, even though the PTY looks busy", () => {
    // The false-"working" fix. `deriveTone` maps a settled-at-the-prompt pane to `ready`, which
    // `TONE_TO_FLEET` publishes as `running` — so an agent doing nothing has always reported
    // itself live, to the card, the sidebar, and every peer agent reading the fleet.
    expect(resolveAgentStatus(claudeFamily("idle"))).toBe("idle");
  });

  it("reports needs-you when the hook says a human is needed", () => {
    expect(resolveAgentStatus(claudeFamily("needs-input"))).toBe("needs-you");
  });

  it("keeps running when the hook says running", () => {
    expect(resolveAgentStatus({ ...claudeFamily("running"), inferred: "idle" })).toBe("running");
  });

  describe("a running fact the PTY has outlived", () => {
    // Observed 2026-11-23: every hook after the session moved into Claude's daemon was rejected
    // upstream, so the last fact was a `running` one and the pane read "working" for hours
    // beside a plain prompt. A turn end that never arrives must not freeze the badge.
    it("yields to a PTY that settled at its prompt AFTER the fact", () => {
      const input = { ...claudeFamily("running", 60_000), ptyIdleSinceMs: NOW - 30_000 };
      expect(resolveAgentStatus(input)).toBe("idle");
    });

    it("stays running when the PTY settled BEFORE the fact (a new turn just began)", () => {
      const input = { ...claudeFamily("running", 1_000), ptyIdleSinceMs: NOW - 5_000 };
      expect(resolveAgentStatus(input)).toBe("running");
    });

    it("stays running when the PTY is not at its prompt", () => {
      expect(resolveAgentStatus(claudeFamily("running", 60_000))).toBe("running");
    });
  });

  it("maps the remaining hook states onto their canvas equivalents", () => {
    expect(resolveAgentStatus(claudeFamily("error"))).toBe("error");
    expect(resolveAgentStatus(claudeFamily("ended"))).toBe("completed");
  });

  describe("capability gating", () => {
    it("honours a Codex turn end, because that is the one thing Codex reports", () => {
      // Codex's entire surface into Lotus is a single `agent-turn-complete` notify. It IS
      // hook-capable — just not step-reporting.
      const codex = {
        inferred: "running" as const,
        fact: { paneId: "p-1", turn: "idle", atMs: NOW },
        reportsTurnEnd: true,
        reportsSteps: false,
        now: NOW,
      };
      expect(resolveAgentStatus(codex)).toBe("idle");
    });

    it("still takes Codex's mid-turn state from the PTY", () => {
      // A turn stream that only ever says `idle` carries no information about being mid-turn, so
      // the timers stay Codex's only signal there. Gating this on `isHookCapableRunner` — which is
      // TRUE for Codex — would have silenced it entirely (canvas-fleet.ts:64-74).
      const codex = {
        inferred: "running" as const,
        fact: { paneId: "p-1", turn: "running", atMs: NOW },
        reportsTurnEnd: true,
        reportsSteps: false,
        now: NOW,
      };
      expect(resolveAgentStatus(codex)).toBe("running");
    });

    it("never claims needs-you for a runner that cannot report a prompt", () => {
      // `cursor` and a non-claude custom command have no hooks at all. A `needs-input` attributed
      // to one is a correlation bug, not a fact — invariant 2: needs-you is never inferred.
      const hookless = {
        inferred: "running" as const,
        fact: { paneId: "p-1", turn: "needs-input", atMs: NOW },
        reportsTurnEnd: false,
        reportsSteps: false,
        now: NOW,
      };
      expect(resolveAgentStatus(hookless)).toBe("running");
    });

    it("leaves a pane with no hook fact exactly as it is today", () => {
      // Invariant 1, and what makes every slice safely revertible.
      for (const inferred of ["idle", "connecting", "running", "stalled", "completed", "error"] as const) {
        expect(
          resolveAgentStatus({
            inferred,
            fact: undefined,
            reportsTurnEnd: true,
            reportsSteps: true,
            now: NOW,
          }),
        ).toBe(inferred);
      }
    });
  });

  describe("precedence", () => {
    it("lets a dead PTY win over any hook fact", () => {
      // A dead pane is dead whatever the last hook said. Without this, a pane that crashed while
      // blocked would sit on the board asking for input forever.
      expect(
        resolveAgentStatus({ ...claudeFamily("needs-input"), inferred: "error" }),
      ).toBe("error");
      expect(
        resolveAgentStatus({ ...claudeFamily("needs-input"), inferred: "completed" }),
      ).toBe("completed");
    });

    it("declines a turn value it does not recognise", () => {
      // The wire vocabulary lives in `scripts/agent-notify/event-mapping.mjs` and can grow without
      // a desktop rebuild. Guessing at a future state is worse than continuing to infer.
      expect(resolveAgentStatus(claudeFamily("compacting"))).toBe("running");
    });
  });

  describe("a fact that outlived its session", () => {
    it("is ignored once it is older than the freshness bound", () => {
      // Observed live on 2026-08-24: a real `idle` fact sat in Rust's store with an age of
      // 15,603,751 ms (~4.3 h) — it belonged to a previous working session. Rust's store outlives
      // a frontend reload, so a hydrate can pull in a fact describing a pane as it was hours ago.
      expect(resolveAgentStatus(claudeFamily("needs-input", TURN_FRESH_MS + 1))).toBe("running");
    });

    it("is honoured right up to the bound, because a real prompt persists until answered", () => {
      // Deliberately generous: expiring a genuine unanswered prompt is the worse error. A human
      // can be away for hours, and no further hook will fire while the agent is blocked.
      expect(resolveAgentStatus(claudeFamily("needs-input", TURN_FRESH_MS - 1))).toBe("needs-you");
    });
  });

  describe("an ask the human has already answered", () => {
    it("stops reporting needs-you once a human acted after the ask landed", () => {
      // The live bug (2026-08-25): rejecting a permission prompt produces NO hook event — the tool
      // never runs, so no `tool-post`, and Claude ends the turn without a `Stop`. The pane sat at
      // `needs-input` for 200+ seconds with its terminal plainly back at the prompt.
      //
      // Asserted `running` when first written, which was the `inferred` fallback — and `inferred`
      // is the PTY guess, i.e. the false-"working" state. The second live run showed why that was
      // too weak, so the rule became "a fact older than the human's action means the pane is at
      // its prompt". Same behaviour under test; a better answer.
      expect(
        resolveAgentStatus({
          ...claudeFamily("needs-input", 30_000),
          answeredAtMs: NOW - 10_000, // acted 20s AFTER the ask
        }),
      ).toBe("idle");
    });

    it("still reports needs-you for an ask raised AFTER the human last acted", () => {
      // The reason this is a timestamp comparison and not a boolean: an agent can ask again the
      // moment it is unblocked, and that second ask must not be swallowed by the first answer.
      expect(
        resolveAgentStatus({
          ...claudeFamily("needs-input", 5_000),
          answeredAtMs: NOW - 60_000, // acted long before the ask
        }),
      ).toBe("needs-you");
    });

    it("ignores an answer that lands in the same millisecond as the ask", () => {
      // A tie means the ask is at least as recent as the action; suppressing it would hide a live
      // prompt on the strength of a coincidence.
      expect(
        resolveAgentStatus({ ...claudeFamily("needs-input", 0), answeredAtMs: NOW }),
      ).toBe("needs-you");
    });

    it("leaves every other turn state alone", () => {
      // The mark only ever SUPPRESSES an ask. It must not touch a running or idle report, or it
      // would become a second, weaker source for states the hook already owns.
      expect(
        resolveAgentStatus({ ...claudeFamily("running"), answeredAtMs: NOW }),
      ).toBe("running");
      expect(
        resolveAgentStatus({ ...claudeFamily("idle"), answeredAtMs: NOW }),
      ).toBe("idle");
    });

    it("behaves exactly as before when no human has ever acted", () => {
      expect(resolveAgentStatus(claudeFamily("needs-input"))).toBe("needs-you");
    });
  });

  describe("a fact that predates the human's last action", () => {
    it("reports idle when a stale running fact is all that is left", () => {
      // Observed live 2026-08-25: rejecting a tool ends the turn and fires NO hook — not even a
      // `Stop`. The last fact stayed `running` for 80 seconds with the terminal back at its prompt,
      // so the pane reported itself busy and RC-2 then escalated it to `stalled`.
      //
      // A human acting on the pane IS a turn boundary. Anything the hook said before it describes
      // the past, and the honest present is "at the prompt".
      expect(
        resolveAgentStatus({
          ...claudeFamily("running", 80_000),
          answeredAtMs: NOW - 60_000,
        }),
      ).toBe("idle");
    });

    it("does not resolve to the PTY guess, which is the lie this plan removes", () => {
      // Falling back to `inferred` here returns `running` — TONE_TO_STATUS maps a settled `ready`
      // pane to busy on purpose, as the INPUT the resolver corrects. Returning to it after
      // suppressing a stale fact would reinstate the false-"working" state permanently.
      expect(
        resolveAgentStatus({
          ...claudeFamily("needs-input", 30_000),
          inferred: "running",
          answeredAtMs: NOW - 10_000,
        }),
      ).toBe("idle");
    });

    it("yields to any hook fact newer than the action", () => {
      // Typing a new instruction fires UserPromptSubmit → `running`, which is NEWER than the mark
      // and must win. This is what keeps the idle answer wrong for milliseconds at worst.
      expect(
        resolveAgentStatus({
          ...claudeFamily("running", 1_000),
          answeredAtMs: NOW - 30_000,
        }),
      ).toBe("running");
    });

    it("still lets a dead PTY win", () => {
      expect(
        resolveAgentStatus({
          ...claudeFamily("running", 80_000),
          inferred: "error",
          answeredAtMs: NOW - 60_000,
        }),
      ).toBe("error");
    });

    it("leaves a hook-less runner on its PTY guess", () => {
      // No hook fact means no turn boundary to compare against, so there is nothing to go stale.
      expect(
        resolveAgentStatus({
          inferred: "running",
          fact: undefined,
          reportsTurnEnd: true,
          reportsSteps: true,
          answeredAtMs: NOW - 1_000,
          now: NOW,
        }),
      ).toBe("running");
    });
  });
});

/**
 * The pane nobody has used yet.
 *
 * `TONE_TO_STATUS` maps a settled `ready` pane to `running` on purpose — it is the input this
 * resolver corrects. The correction was only ever written for panes that HAVE a hook fact, so an
 * agent that had never been given a turn had nothing to correct it and reported itself busy for as
 * long as it lived. Observed live 2026-08-27 in the Fleet rail: three agents spawned five minutes
 * earlier, never asked anything, all reading `working · 5m`.
 */
describe("at the prompt, never asked anything", () => {
  const NOW = 1_000_000;
  const base = {
    inferred: "running" as const,
    fact: undefined,
    reportsTurnEnd: true,
    reportsSteps: true,
    atPrompt: true,
    now: NOW,
  };

  it("is idle when the runner would have announced a turn by hook", () => {
    expect(resolveAgentStatus(base)).toBe("idle");
  });

  // Bytes are the only signal a step-silent runner has. Calling this pane idle would hide an agent
  // that really is working, with no hook coming to put it right.
  it("keeps the PTY's guess for a step-silent runner", () => {
    expect(resolveAgentStatus({ ...base, reportsSteps: false })).toBe("running");
  });

  // Mid-turn, the launch machine says `running`, not `ready` — so this correction never applies.
  it("does not touch a pane that is not at its prompt", () => {
    expect(resolveAgentStatus({ ...base, atPrompt: false })).toBe("running");
  });

  // A live fact outranks the launch phase in both directions; that is the whole rule of this file.
  it("yields to a fresh hook fact", () => {
    const fact = { paneId: "p-1", turn: "running" as const, atMs: NOW };
    expect(resolveAgentStatus({ ...base, fact })).toBe("running");
  });

  it("applies once a fact has expired, rather than reinstating the false busy", () => {
    const stale = { paneId: "p-1", turn: "running" as const, atMs: NOW - TURN_FRESH_MS - 1 };
    expect(resolveAgentStatus({ ...base, fact: stale })).toBe("idle");
  });

  // A dead pane is dead whatever the launch phase says — checked before any of this.
  it("never overrides a finished or failed pane", () => {
    expect(resolveAgentStatus({ ...base, inferred: "error" })).toBe("error");
    expect(resolveAgentStatus({ ...base, inferred: "completed" })).toBe("completed");
  });
});
