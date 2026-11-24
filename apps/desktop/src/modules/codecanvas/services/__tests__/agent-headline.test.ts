import { describe, expect, it } from "vitest";
import { composeHeadline, headlineOf, PROMPT_MAX, summarizePrompt } from "../agent-headline";
import type { AgentState } from "../narration/agent-state-registry";

const NOW = 1_700_000_000_000;

const state = (over: Partial<AgentState> = {}): AgentState => ({
  paneId: "canvas:cp_1:a1",
  currentTool: null,
  lastTool: null,
  filesTouched: [],
  errorCount: 0,
  lastErrorAt: null,
  lastPrompt: null,
  turnActive: false,
  eventCount: 1,
  lastEventAt: NOW,
  ...over,
});

describe("composeHeadline", () => {
  it("says what the agent is doing right now, in the present", () => {
    expect(composeHeadline(state({ currentTool: "edit" }), NOW)).toBe("editing");
  });

  it("says what it just finished, in the past, once no tool is running", () => {
    // Tense is the signal that the work is over — the same convention narration-line.ts uses, and
    // the reason its table carries both forms.
    expect(composeHeadline(state({ lastTool: "bash" }), NOW)).toBe("ran a command");
  });

  it("prefers the running tool over the finished one", () => {
    expect(composeHeadline(state({ currentTool: "grep", lastTool: "edit" }), NOW)).toBe("searching");
  });

  it("names the area once it knows one", () => {
    // `areaOf` is the dominant parent directory of the files touched — a label that tells two agents
    // in one repo apart, which the repo name cannot.
    expect(
      composeHeadline(
        state({
          currentTool: "edit",
          filesTouched: ["/repo/src/auth/login.ts", "/repo/src/auth/token.ts"],
        }),
        NOW,
      ),
    ).toBe("editing · auth");
  });

  it("follows the dominant area, not the most recent file", () => {
    // Stability: the newest file flaps with every tool call, the dominant directory does not.
    expect(
      composeHeadline(
        state({
          currentTool: "read",
          filesTouched: [
            "/repo/src/auth/a.ts",
            "/repo/src/auth/b.ts",
            "/repo/src/web/one-off.ts",
          ],
        }),
        NOW,
      ),
    ).toBe("reading · auth");
  });

  it("leaves the area out rather than inventing one", () => {
    expect(composeHeadline(state({ currentTool: "bash" }), NOW)).toBe("running a command");
  });

  it("leads with a fresh failure, which is the most useful thing it can say", () => {
    // Keyed on the ERROR's own timestamp. This first cited `salienceOf`, whose freshness is of the
    // last EVENT — see the two cases at the bottom of this file for why that could not work here.
    expect(
      composeHeadline(
        state({
          currentTool: "edit",
          errorCount: 1,
          lastErrorAt: NOW - 1_000,
          filesTouched: ["/repo/src/auth/a.ts"],
        }),
        NOW,
      ),
    ).toBe("something failed · auth");
  });

  it("says nothing about a failure it has no timestamp for", () => {
    // `errorCount` alone cannot date the failure, and a headline must not imply recency it cannot
    // establish. A pane whose facts predate `lastErrorAt` reads as ordinary work rather than
    // claiming a failure that may be hours old.
    expect(
      composeHeadline(state({ currentTool: "edit", errorCount: 1, lastErrorAt: null }), NOW),
    ).toBe("editing");
  });

  it("says nothing when no tool has run yet", () => {
    // Invariant 3: when there is nothing factual to say, say nothing and let the name stand alone.
    expect(composeHeadline(state(), NOW)).toBeNull();
  });

  it("says nothing for a pane it has never observed", () => {
    expect(composeHeadline(undefined, NOW)).toBeNull();
  });

  it("names an unfamiliar tool without pretending to know it", () => {
    // The tool vocabulary grows outside this repo. An unknown name must not render as `undefined`
    // or leak the raw identifier into a title.
    expect(composeHeadline(state({ currentTool: "mcp__something__query" }), NOW)).toBe(
      "working on something",
    );
  });

  it("never returns the agent's own prose", () => {
    // Invariant: facts only. `narrationTemplateLine`'s `final` branch returns the first sentence of
    // the agent's last message — right for speech, wrong for a title, and unreachable from here
    // because AgentState carries no prose at all. This pins that the composer's inputs stay facts.
    const composed = composeHeadline(
      state({ currentTool: "edit", filesTouched: ["/repo/src/auth/a.ts"] }),
      NOW,
    );

    expect(composed).not.toMatch(/[.!?]$/);
    expect(composed!.length).toBeLessThan(40);
  });

  it("stops leading with a failure once the FAILURE is old, even while work continues", () => {
    // The flaw `salienceOf` hides for this purpose. Its freshness is of the LAST EVENT, not of the
    // error: `errorCount > 0 && lastEventAt fresh` → `blocked`. That is right for narration, which
    // decides what to say right now and should let a recent failure pierce. It is wrong for a
    // persistent title — one error early in a long session would read "something failed" for the
    // rest of it, as long as the agent kept working.
    //
    // A headline needs the error's OWN recency.
    expect(
      composeHeadline(
        state({
          currentTool: "edit",
          errorCount: 1,
          lastErrorAt: NOW - 120_000, // failed two minutes ago
          lastEventAt: NOW, // and has been busy since
        }),
        NOW,
      ),
    ).toBe("editing");
  });

  it("still leads with a failure that just happened", () => {
    expect(
      composeHeadline(
        state({ currentTool: "edit", errorCount: 1, lastErrorAt: NOW - 2_000, lastEventAt: NOW }),
        NOW,
      ),
    ).toBe("something failed");
  });

  describe("the stability key (measured, not chosen in the abstract)", () => {
    // Measured 2026-08-26 from a real 60-entry transcript ring: turns contain 1-5 tool calls,
    // seconds apart, each producing a `tool-pre` then a `tool-post`. The composed text therefore
    // flips present → past → present twice per call. A title that changes every second or two is
    // unreadable, and no timer is needed to fix it: the TENSE is not new information.
    //
    // So the composer returns a key alongside the text, and the store (Slice 3) replaces a headline
    // only when the key changes. Verb identity, area, and whether the TURN is still live are
    // significant; the pre/post flip inside a live turn is not.
    //
    // This block first read the last clause as "tense is never significant", and asserted in one
    // test that the past text was composed AND that its key equalled the present form's. Those two
    // claims cancel: an equal key means the store keeps the present text, so the past string the
    // test checked could not reach a screen. It went green and the defect shipped — a card reading
    // "running a command" next to an IDLE badge, caught by the operator on 2026-08-26.
    //
    // The lesson is about the seam, not the tense. A test that exercises a pure function in
    // isolation cannot see a caller that discards its output, so where the two are designed to work
    // as a pair, assert the pair's behaviour.

    it("holds one key across the pre/post flip within a turn, which is the churn measured", () => {
      const running = headlineOf(state({ currentTool: "bash", turnActive: true }), NOW);
      const between = headlineOf(state({ lastTool: "bash", turnActive: true }), NOW);

      expect(between.text).toBe("running a command");
      expect(between.key).toBe(running.key);
    });

    it("changes the key when the tool changes", () => {
      expect(headlineOf(state({ currentTool: "edit" }), NOW).key).not.toBe(
        headlineOf(state({ currentTool: "grep" }), NOW).key,
      );
    });

    it("changes the key when the area changes", () => {
      const auth = headlineOf(state({ currentTool: "edit", filesTouched: ["/r/src/auth/a.ts"] }), NOW);
      const web = headlineOf(state({ currentTool: "edit", filesTouched: ["/r/src/web/a.ts"] }), NOW);

      expect(web.key).not.toBe(auth.key);
    });

    it("gives one key to tools that share a phrase, because the title is identical", () => {
      // `grep` and `glob` both read "searching". Two keys for one visible string would let the
      // store churn on a change nobody can see.
      expect(headlineOf(state({ currentTool: "grep" }), NOW).key).toBe(
        headlineOf(state({ currentTool: "glob" }), NOW).key,
      );
    });

    it("marks a failure as its own key, so it always displaces the work line", () => {
      const failing = headlineOf(state({ currentTool: "edit", lastErrorAt: NOW - 1_000 }), NOW);
      const working = headlineOf(state({ currentTool: "edit" }), NOW);

      expect(failing.text).toBe("something failed");
      expect(failing.key).not.toBe(working.key);
    });

    it("has no key when there is no headline", () => {
      expect(headlineOf(state(), NOW)).toEqual({ text: null, key: null });
    });
  });
});

describe("headlineOf across a turn boundary", () => {
  // The defect the operator caught on 2026-08-26: the card read "running a command" in the present
  // tense while the badge, the inbox and the terminal all agreed the agent was IDLE and done.
  //
  // Cause: the store replaces only on a key change, and the `lastTool` branch keyed on the PRESENT
  // form. So the past form composed on line 97 could never displace the present form already on
  // screen — that render was dead code from the first commit. The title froze mid-turn and stayed
  // frozen, which is the false-"working" family again, one layer up.
  //
  // The fix is to stop conflating two different flips. WITHIN a turn the tense carries nothing (a
  // 60-entry ring showed pre/post pairs seconds apart), so present is held throughout. At the END of
  // a turn the tense is the whole point.

  it("holds the present tense between two tools in a live turn", () => {
    // What the measurement was really about: `tool_post` lands, `currentTool` clears, and the agent
    // is still very much working. Rendering the past here is what churned.
    const between = state({ lastTool: "bash", turnActive: true });

    expect(headlineOf(between, NOW).text).toBe("running a command");
  });

  it("keeps one key across pre -> post -> pre, so the store never repaints", () => {
    const during = headlineOf(state({ currentTool: "bash", turnActive: true }), NOW);
    const between = headlineOf(state({ lastTool: "bash", turnActive: true }), NOW);

    expect(between.key).toBe(during.key);
  });

  it("switches to the past once the turn has ended", () => {
    const ended = state({ lastTool: "bash", turnActive: false });

    expect(headlineOf(ended, NOW).text).toBe("ran a command");
  });

  it("changes its key at the turn boundary, which is what lets the past reach the screen", () => {
    // The regression guard proper. Equal keys here mean the store holds the stale present tense and
    // the card lies about a finished agent — exactly the reported bug.
    const live = headlineOf(state({ lastTool: "bash", turnActive: true }), NOW);
    const ended = headlineOf(state({ lastTool: "bash", turnActive: false }), NOW);

    expect(ended.key).not.toBe(live.key);
  });

  it("still lets a fresh failure outrank a live turn", () => {
    expect(
      headlineOf(
        state({ lastTool: "bash", turnActive: true, errorCount: 1, lastErrorAt: NOW - 1_000 }),
        NOW,
      ).text,
    ).toBe("something failed");
  });
});

describe("summarizePrompt", () => {
  it("takes the first line, which is where a person puts the ask", () => {
    expect(summarizePrompt("perbaiki judul agent\n\nkonteksnya panjang...")).toBe(
      "perbaiki judul agent",
    );
  });

  it("skips leading blank lines rather than returning nothing", () => {
    expect(summarizePrompt("\n\n  lanjut Slice 4  ")).toBe("lanjut Slice 4");
  });

  it("collapses runs of whitespace, so a pasted line stays one line", () => {
    expect(summarizePrompt("jelaskan   perubahan\tyang belum commit")).toBe(
      "jelaskan perubahan yang belum commit",
    );
  });

  it("caps a long prompt", () => {
    // The producer allows 4000 characters. The card ellipsises in CSS, so this cap is not about
    // looks — it keeps the headline store small and stops the triage lane wrapping to three lines.
    const long = "a".repeat(300);

    const out = summarizePrompt(long);

    expect(out).toHaveLength(PROMPT_MAX);
    expect(out?.endsWith("…")).toBe(true);
  });

  it("leaves a prompt that fits exactly alone", () => {
    const exact = "b".repeat(PROMPT_MAX);

    expect(summarizePrompt(exact)).toBe(exact);
  });

  it("returns null for nothing worth showing", () => {
    expect(summarizePrompt("")).toBeNull();
    expect(summarizePrompt("   \n\t  ")).toBeNull();
  });

  it("keeps a slash command as typed", () => {
    // Stripping the "/tdd" would be guessing at intent. The operator typed it; it is part of the ask.
    expect(summarizePrompt("/tdd lanjutkan Slice 1 sampai Slice 3")).toBe(
      "/tdd lanjutkan Slice 1 sampai Slice 3",
    );
  });
});

describe("the prompt as the headline", () => {
  // The design reversal of 2026-08-26. The tool-name headline was honest and useless: a Bash-heavy
  // agent has no tool variety, and `extractToolFilePath` reads only `file_path` — which Bash has
  // none of — so `filesTouched` stays empty and the area label never resolves either. Every such
  // agent read the constant string "ran a command" for its whole session, which is not a title.
  //
  // The operator's own words were already flowing through the feed the whole time: `toNarrationEvent`
  // sets `neutral` to `payload.userPrompt` on a prompt drop, and `observe` discarded it. No model, no
  // hook change — the goal-shaped headline was free.

  it("says what the agent was asked to do", () => {
    expect(
      composeHeadline(state({ lastPrompt: "jelaskan perubahan yang belum commit" }), NOW),
    ).toBe("jelaskan perubahan yang belum commit");
  });

  it("outranks the tool phrase, which is the whole point of the change", () => {
    expect(
      composeHeadline(state({ lastPrompt: "perbaiki judul agent", currentTool: "bash" }), NOW),
    ).toBe("perbaiki judul agent");
  });

  it("does not move while tools come and go inside the turn", () => {
    // A goal is stable by nature, so this needs no key trick at all — the churn the key was invented
    // for cannot arise on this branch.
    const during = headlineOf(state({ lastPrompt: "run the tests", currentTool: "bash" }), NOW);
    const between = headlineOf(state({ lastPrompt: "run the tests", lastTool: "bash" }), NOW);
    const ended = headlineOf(
      state({ lastPrompt: "run the tests", lastTool: "bash", turnActive: false }),
      NOW,
    );

    expect(between.key).toBe(during.key);
    expect(ended.key).toBe(during.key);
    expect(ended.text).toBe("run the tests");
  });

  it("survives the turn ending, because it is what the agent worked on", () => {
    expect(
      composeHeadline(state({ lastPrompt: "run the tests", turnActive: false }), NOW),
    ).toBe("run the tests");
  });

  it("changes when the next ask arrives", () => {
    const first = headlineOf(state({ lastPrompt: "run the tests" }), NOW);
    const second = headlineOf(state({ lastPrompt: "now fix the lint" }), NOW);

    expect(second.key).not.toBe(first.key);
  });

  it("falls back to the tool phrase for a pane whose ask was never seen", () => {
    // Lotus attaches to panes mid-turn — reconnects, a reopened board. The tool line is worth less
    // than the ask but is a great deal better than nothing.
    expect(composeHeadline(state({ currentTool: "edit" }), NOW)).toBe("editing");
  });

  it("still lets a fresh failure pierce", () => {
    expect(
      composeHeadline(
        state({ lastPrompt: "run the tests", errorCount: 1, lastErrorAt: NOW - 1_000 }),
        NOW,
      ),
    ).toBe("something failed");
  });
});

