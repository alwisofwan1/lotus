import { describe, it, expect, beforeEach } from "vitest";
import {
  createTerminalActivityRegistry,
  getTerminalActivity,
  noteTerminalCommandBoundary,
  noteTerminalOutputChunk,
  resetTerminalActivity,
  type TerminalActivityRegistry,
} from "../terminal-activity-registry";

/** Controllable clock: timers fire only when advance() crosses their deadline. */
function fakeClock() {
  let t = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout(fn: () => void, ms: number) {
      const timer = { at: t + ms, fn };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms: number) {
      t += ms;
      for (const timer of [...timers]) {
        if (timer.at <= t) {
          timers.delete(timer);
          timer.fn();
        }
      }
    },
  };
}

const WORKING = "Working(3s · esc to interrupt)";

describe("terminal-activity-registry", () => {
  let clock: ReturnType<typeof fakeClock>;
  let reg: TerminalActivityRegistry;

  beforeEach(() => {
    clock = fakeClock();
    reg = createTerminalActivityRegistry({ clock, workingQuietMs: 1000 });
  });

  it("defaults to idle for an unknown pane", () => {
    expect(reg.get("p1")).toBe("idle");
  });

  it("stamps when a pane ENTERS an activity, not when it is merely observed again", () => {
    expect(reg.since("p1")).toBeUndefined();
    clock.advance(500);
    reg.noteCommandBoundary("p1", { kind: "command-begin" });
    expect(reg.since("p1")).toBe(500);
    clock.advance(200);
    reg.noteOutputChunk("p1", "still compiling\n");
    expect(reg.since("p1")).toBe(500);
    clock.advance(300);
    reg.noteCommandBoundary("p1", { kind: "command-end", exitCode: 0 });
    expect(reg.since("p1")).toBe(1000);
  });

  it("marks a plain shell command running between command-begin and command-end", () => {
    reg.noteCommandBoundary("p1", { kind: "command-begin" });
    expect(reg.get("p1")).toBe("running");
    reg.noteOutputChunk("p1", "compiling...\n");
    expect(reg.get("p1")).toBe("running");
    reg.noteCommandBoundary("p1", { kind: "command-end", exitCode: 0 });
    expect(reg.get("p1")).toBe("idle");
  });

  it("treats prompt-start as a return to idle even if command-end was missed", () => {
    reg.noteCommandBoundary("p1", { kind: "command-begin" });
    expect(reg.get("p1")).toBe("running");
    reg.noteCommandBoundary("p1", { kind: "prompt-start" });
    expect(reg.get("p1")).toBe("idle");
  });

  it("for an interactive agent, runs only while thinking and idles while awaiting input", () => {
    reg.noteCommandBoundary("p1", { kind: "command-begin" }); // user launched `claude`
    reg.noteOutputChunk("p1", WORKING);                        // agent thinking
    expect(reg.get("p1")).toBe("running");
    clock.advance(1000);                                       // working lines stop arriving
    expect(reg.get("p1")).toBe("idle");                        // agent now awaiting input
    reg.noteOutputChunk("p1", WORKING);                        // agent thinking again
    expect(reg.get("p1")).toBe("running");
  });

  it("detects agent activity even without OSC 133 (SSH / no shell integration)", () => {
    reg.noteOutputChunk("p1", WORKING);
    expect(reg.get("p1")).toBe("running");
    clock.advance(1000);
    expect(reg.get("p1")).toBe("idle");
  });

  it("keeps a submitted plain shell command running past the keystroke quiet window until the prompt returns", () => {
    reg = createTerminalActivityRegistry({ clock, userInputQuietMs: 800, submittedCommandQuietMs: 5_000 });

    reg.noteUserInput("p1", { submitted: true, agentTurnCandidate: false, data: "sleep 2 && echo done\r" });
    expect(reg.get("p1")).toBe("running");

    clock.advance(900);
    expect(reg.get("p1")).toBe("running");

    reg.noteOutputChunk("p1", "done\r\n$ ");
    expect(reg.get("p1")).toBe("idle");
  });

  it("caps submitted shell fallback activity if no prompt signal returns", () => {
    reg = createTerminalActivityRegistry({ clock, userInputQuietMs: 800, submittedCommandQuietMs: 2_000 });

    reg.noteUserInput("p1", { submitted: true, agentTurnCandidate: false, data: "sleep 10\r" });
    clock.advance(1_900);
    expect(reg.get("p1")).toBe("running");

    clock.advance(100);
    expect(reg.get("p1")).toBe("idle");
  });

  it("notifies subscribers on transitions only", () => {
    const seen: string[] = [];
    reg.subscribe("p1", (a) => seen.push(a));
    reg.noteCommandBoundary("p1", { kind: "command-begin" });
    reg.noteOutputChunk("p1", "still running\n");
    reg.noteCommandBoundary("p1", { kind: "command-end", exitCode: 0 });
    expect(seen).toEqual(["idle", "running", "idle"]);
  });

  it("resets a pane on close", () => {
    reg.noteCommandBoundary("p1", { kind: "command-begin" });
    expect(reg.get("p1")).toBe("running");
    reg.reset("p1");
    expect(reg.get("p1")).toBe("idle");
  });

  it("standalone runtime exports snap to idle on agent standby output", () => {
    const paneId = "export-standby-p1";
    const standby = "Sonnet 4.6 | 5h: 0%\n►► auto mode on (shift+tab to cycle)";

    resetTerminalActivity(paneId);
    noteTerminalCommandBoundary(paneId, { kind: "command-begin" });
    expect(getTerminalActivity(paneId)).toBe("running");

    expect(() => noteTerminalOutputChunk(paneId, standby)).not.toThrow();
    expect(getTerminalActivity(paneId)).toBe("idle");

    resetTerminalActivity(paneId);
  });

  describe("agent standby — commandActive heuristic stops at ready output", () => {
    // Realistic Claude Code status bar: auto mode on is in the tail lines.
    const STANDBY = "Sonnet 4.6 | 5h: 0%\n►► auto mode on (shift+tab to cycle)\nClaude in Chrome enabled · /chrome";

    it("stays running while claude is loading (no standby signal yet)", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", "Claude Code v2.1.158\nSonnet 4.6 with high effort");
      expect(reg.get("p1")).toBe("running");
    });

    it("drops to idle once the agent standby status bar appears (stream fast-path)", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", STANDBY);
      expect(reg.get("p1")).toBe("idle");
    });

    it("drops to idle for the small-chevron Claude standby footer from xterm", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", "Sonnet 4.6\n▸▸ auto mode on (shift+tab to cycle) · ← for agents");
      expect(reg.get("p1")).toBe("idle");
    });

    it("drops to idle when a Codex idle footer appears after launch", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk(
        "p1",
        "OpenAI Codex\n> Improve documentation in @filename\nctrl+c to exit · gpt-5.5 high · ~/repo",
      );
      expect(reg.get("p1")).toBe("idle");
    });

    it("drops to idle for Pi/OpenAI Codex auto footer", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk(
        "p1",
        "↑4.9k ↓168 $0.030 (sub) 1.9%/272k (auto) (openai-codex) gpt-5.5 · high",
      );
      expect(reg.get("p1")).toBe("idle");
    });

    it("settles to idle via noteAgentStandby after the quiet window (xterm buffer path)", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", "Working(3s · esc to interrupt)");
      reg.noteAgentStandby("p1");
      expect(reg.get("p1")).toBe("running");
      clock.advance(1000);
      expect(reg.get("p1")).toBe("idle");
    });

    it("repaint chunks do NOT flip back to running after standby latch set", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", "Working(3s · esc to interrupt)");
      reg.noteAgentStandby("p1");
      expect(reg.get("p1")).toBe("running");
      clock.advance(1000);
      expect(reg.get("p1")).toBe("idle");
      // Status bar repaint arrives as a new chunk — must not flip to running
      reg.noteOutputChunk("p1", "status bar repaint with no standby pattern");
      expect(reg.get("p1")).toBe("idle");
    });

    it("keeps running during an agent turn even when the idle footer is still visible", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", STANDBY);
      expect(reg.get("p1")).toBe("idle");

      reg.noteUserInput("p1", { data: "fix it\r", submitted: true });
      reg.noteAgentStandby("p1"); // xterm buffer still contains the idle footer during repaint
      expect(reg.get("p1")).toBe("running");
      clock.advance(500);
      reg.noteOutputChunk("p1", "Di ujung senja yang perlahan redup,");
      expect(reg.get("p1")).toBe("running");
      clock.advance(1000);
      expect(reg.get("p1")).toBe("idle");
    });

    it("treats plain response output after user input as running even without Working status", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", STANDBY);
      expect(reg.get("p1")).toBe("idle");

      reg.noteUserInput("p1", { data: "fix it\r", submitted: true });
      clock.advance(800);
      reg.noteOutputChunk("p1", "Streaming response line without status chrome");
      expect(reg.get("p1")).toBe("running");
      clock.advance(1000);
      expect(reg.get("p1")).toBe("idle");
    });

    it("treats Pi/Codex response repaint chunks as running even when the idle footer is still visible", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk(
        "p1",
        "↑4.9k ↓168 $0.030 (sub) 1.9%/272k (auto) (openai-codex) gpt-5.5 · high",
      );
      expect(reg.get("p1")).toBe("idle");

      reg.noteOutputChunk(
        "p1",
        "say hello in one line\nHello!\n↑4.9k ↓6 $0.025 (sub) 1.8%/272k (auto) (openai-codex) gpt-5.5 · high",
      );

      expect(reg.get("p1")).toBe("running");
      clock.advance(1000);
      expect(reg.get("p1")).toBe("idle");
    });

    it("goes running again when the agent starts working after standby", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", STANDBY);
      expect(reg.get("p1")).toBe("idle");
      reg.noteOutputChunk("p1", "Working(3s · esc to interrupt)");
      expect(reg.get("p1")).toBe("running");
    });

    it("returns to idle after agent finishes working (quiet period)", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", STANDBY);
      reg.noteOutputChunk("p1", "Working(3s · esc to interrupt)");
      expect(reg.get("p1")).toBe("running");
      clock.advance(1000);
      expect(reg.get("p1")).toBe("idle");
    });
  });

  describe("tier 3 — streaming response keeps badge running", () => {
    const WORKING = "Working(3s · esc to interrupt)";
    const STANDBY = "Sonnet 4.6 | 5h: 0%\n►► auto mode on (shift+tab to cycle)";

    it("stays running while agent streams plain text content after working status", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", WORKING);               // tier 2 — marks agent known
      expect(reg.get("p1")).toBe("running");
      clock.advance(500);
      reg.noteOutputChunk("p1", "Here is the plan:\n- Step 1"); // tier 3 — refreshes timer
      clock.advance(500);
      reg.noteOutputChunk("p1", "- Step 2\n- Step 3");          // tier 3 — refreshes timer
      expect(reg.get("p1")).toBe("running");
    });

    it("drops to idle after quiet period when no more chunks arrive", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", WORKING);
      reg.noteOutputChunk("p1", "Some response content");
      clock.advance(1000);                               // 1 s silence → idle
      expect(reg.get("p1")).toBe("idle");
    });

    it("settles to idle after the quiet window when standby arrives via stream", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", WORKING);
      reg.noteOutputChunk("p1", "Final response line");
      reg.noteOutputChunk("p1", STANDBY);               // stream tier 1 — ready footer observed
      expect(reg.get("p1")).toBe("running");
      clock.advance(1000);
      expect(reg.get("p1")).toBe("idle");
    });

    it("settles to idle after the quiet window when standby arrives via noteAgentStandby (xterm buffer)", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", WORKING);
      reg.noteOutputChunk("p1", "Final response line");
      reg.noteAgentStandby("p1");                       // xterm buffer path
      expect(reg.get("p1")).toBe("running");
      clock.advance(1000);
      expect(reg.get("p1")).toBe("idle");
    });

    it("does not keep running forever when the rendered standby footer is observed repeatedly", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", WORKING);
      reg.noteOutputChunk("p1", "Final response line");
      reg.noteAgentStandby("p1");
      expect(reg.get("p1")).toBe("running");

      for (let i = 0; i < 5; i++) {
        clock.advance(200);
        reg.noteAgentStandby("p1");
      }

      expect(reg.get("p1")).toBe("idle");
    });

    it("does not keep running forever when standby footer repaint chunks repeat", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", WORKING);
      reg.noteOutputChunk("p1", "Final response line");
      reg.noteOutputChunk("p1", STANDBY);
      expect(reg.get("p1")).toBe("running");

      for (let i = 0; i < 5; i++) {
        clock.advance(200);
        reg.noteOutputChunk("p1", STANDBY);
      }

      expect(reg.get("p1")).toBe("idle");
    });

    it("keeps running when response content arrives after a stale rendered standby footer", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", STANDBY);
      expect(reg.get("p1")).toBe("idle");

      reg.noteUserInput("p1", { data: "fix it\r", submitted: true });
      reg.noteAgentStandby("p1"); // stale rendered footer is still in the xterm buffer
      clock.advance(900);
      expect(reg.get("p1")).toBe("running");

      reg.noteOutputChunk("p1", "Jawaban mulai ditulis");
      clock.advance(900);
      reg.noteOutputChunk("p1", "lanjutan jawaban yang masih streaming");
      clock.advance(900);

      expect(reg.get("p1")).toBe("running");
      clock.advance(1000);
      expect(reg.get("p1")).toBe("idle");
    });

    it("Working(…) after standby clears the latch so tier 3 re-enables", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteAgentStandby("p1");
      expect(reg.get("p1")).toBe("idle");
      reg.noteOutputChunk("p1", "Working(3s · esc to interrupt)"); // new task
      expect(reg.get("p1")).toBe("running");
      reg.noteOutputChunk("p1", "Response content line");           // tier 3 active
      expect(reg.get("p1")).toBe("running");
    });

    it("ignores plain output from unknown commands (tier 3 only for known agents)", () => {
      reg.noteCommandBoundary("p1", { kind: "command-begin" });
      reg.noteOutputChunk("p1", "compiling... done");   // no agent seen yet — tier 3 skipped
      reg.noteCommandBoundary("p1", { kind: "command-end", exitCode: 0 });
      expect(reg.get("p1")).toBe("idle");
    });
  });

  describe("noteUserInput", () => {
    it("typing alone never reads as running — at a shell or an agent prompt", () => {
      reg.noteUserInput("p1", { data: "h", agentTurnCandidate: true });
      reg.noteUserInput("p2", { data: "l", agentTurnCandidate: false });
      expect(reg.get("p1")).toBe("idle");
      expect(reg.get("p2")).toBe("idle");
    });

    it("the echo of a keystroke at an agent standby prompt stays idle", () => {
      reg.noteAgentStandby("p1");
      reg.noteUserInput("p1", { data: "h", agentTurnCandidate: true });
      reg.noteOutputChunk("p1", "h");
      expect(reg.get("p1")).toBe("idle");
    });

    it("a submit at an agent prompt reopens the turn, so the reply reads as running", () => {
      reg.noteAgentStandby("p1");
      reg.noteUserInput("p1", { data: "\r", submitted: true, agentTurnCandidate: true });
      reg.noteOutputChunk("p1", "Here is the answer");
      expect(reg.get("p1")).toBe("running");
    });
  });
});
