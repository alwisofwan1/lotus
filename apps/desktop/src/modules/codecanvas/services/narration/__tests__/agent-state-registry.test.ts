import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, areaOf, createAgentStateRegistry, salienceOf } from "../agent-state-registry";
import type { NarrationEvent } from "../narration-event";

const NOW = 1_700_000_000_000;

const ev = (over: Partial<NarrationEvent> = {}): NarrationEvent => ({
  kind: "tool_pre",
  tag: "tool_edit",
  neutral: "",
  paneId: "canvas:projA:a1",
  ts: NOW,
  ...over,
});

describe("agent state registry — facts", () => {
  it("tracks the tool an agent is running right now, and clears it when the tool returns", () => {
    const registry = createAgentStateRegistry();
    registry.observe(ev({ kind: "tool_pre", tag: "tool_bash" }));

    expect(registry.get("canvas:projA:a1")?.currentTool).toBe("bash");

    registry.observe(ev({ kind: "tool_post", tag: "tool_post_bash", ts: NOW + 1_500 }));

    expect(registry.get("canvas:projA:a1")?.currentTool).toBeNull();
    expect(registry.get("canvas:projA:a1")?.lastTool).toBe("bash");
  });

  it("counts failures", () => {
    const registry = createAgentStateRegistry();
    registry.observe(ev({ kind: "tool_post", tag: "tool_post_failure" }));
    registry.observe(ev({ kind: "tool_post", tag: "tool_post_failure", ts: NOW + 10 }));

    expect(registry.get("canvas:projA:a1")?.errorCount).toBe(2);
  });

  it("collects touched files without double-counting a file edited twice", () => {
    const registry = createAgentStateRegistry();
    registry.observe(ev({ kind: "tool_post", tag: "tool_post_edit", filePath: "/repo/src/auth.ts" }));
    registry.observe(ev({ kind: "tool_post", tag: "tool_post_edit", filePath: "/repo/src/auth.ts", ts: NOW + 10 }));
    registry.observe(ev({ kind: "tool_post", tag: "tool_post_edit", filePath: "/repo/src/login.ts", ts: NOW + 20 }));

    expect(registry.get("canvas:projA:a1")?.filesTouched).toEqual(["/repo/src/auth.ts", "/repo/src/login.ts"]);
  });

  it("keeps one record per pane", () => {
    const registry = createAgentStateRegistry();
    registry.observe(ev({ paneId: "pane-a" }));
    registry.observe(ev({ paneId: "pane-b" }));

    expect(registry.get("pane-a")).not.toBe(registry.get("pane-b"));
    expect(registry.all()).toHaveLength(2);
  });
});

describe("salience hint", () => {
  const registryWith = (...events: NarrationEvent[]) => {
    const registry = createAgentStateRegistry();
    events.forEach((e) => registry.observe(e));
    return registry.get("canvas:projA:a1")!;
  };

  it("calls a quiet agent routine", () => {
    expect(salienceOf(registryWith(ev({ kind: "tool_post", tag: "tool_post_read" })), NOW)).toBe("routine");
  });

  it("calls an agent mid-tool an active decision", () => {
    expect(salienceOf(registryWith(ev({ kind: "tool_pre", tag: "tool_bash" })), NOW)).toBe("active-decision");
  });

  it("calls an agent with a fresh failure blocked", () => {
    expect(salienceOf(registryWith(ev({ kind: "tool_post", tag: "tool_post_failure" })), NOW)).toBe("blocked");
  });

  it("keeps blocked ahead of active-decision — the failure is the thing to say", () => {
    // An agent that failed and immediately started another tool is still the one that needs the
    // user. Ranking the in-flight tool higher would bury the failure under routine chatter.
    const state = registryWith(
      ev({ kind: "tool_post", tag: "tool_post_failure" }),
      ev({ kind: "tool_pre", tag: "tool_bash", ts: NOW + 100 }),
    );

    expect(salienceOf(state, NOW + 100)).toBe("blocked");
  });

  it("lets a failure go stale rather than marking an agent blocked forever", () => {
    // Without this an agent that hit one error an hour ago would out-rank every live agent for the
    // rest of the session.
    const state = registryWith(ev({ kind: "tool_post", tag: "tool_post_failure" }));

    expect(salienceOf(state, NOW + STALE_AFTER_MS + 1)).toBe("routine");
  });
});

describe("area label", () => {
  const withFiles = (...paths: string[]) => {
    const registry = createAgentStateRegistry();
    // Seed one file-less event so the agent exists even in the no-files case — an agent that has
    // run a Bash or Grep call but edited nothing is the real scenario, not an absent record.
    registry.observe(ev({ kind: "tool_post", tag: "tool_post_bash" }));
    paths.forEach((filePath, i) =>
      registry.observe(ev({ kind: "tool_post", tag: "tool_post_edit", filePath, ts: NOW + 1 + i })),
    );
    return registry.get("canvas:projA:a1")!;
  };

  it("has no area before the agent touches a file", () => {
    expect(areaOf(withFiles())).toBeNull();
  });

  it("names the directory the agent is actually working in", () => {
    // Two agents in one repo both answer to the repo name. The area is what tells them apart:
    // "on the analytics side" vs "over on the frontend".
    expect(areaOf(withFiles("/repo/src/analytics/track.ts", "/repo/src/analytics/report.ts"))).toBe("analytics");
  });

  it("picks the dominant directory, not the most recent file", () => {
    expect(
      areaOf(withFiles("/repo/src/auth/login.ts", "/repo/src/auth/token.ts", "/repo/docs/readme.md")),
    ).toBe("auth");
  });

  it("breaks a tie the same way every time", () => {
    // A flapping label ("auth" one burst, "docs" the next) reads as two different agents.
    const first = areaOf(withFiles("/repo/auth/a.ts", "/repo/docs/b.md"));
    const second = areaOf(withFiles("/repo/docs/b.md", "/repo/auth/a.ts"));

    expect(first).toBe(second);
  });

  describe("wired as a headline source (plans/agent-headlines/ Slice 1)", () => {
    it("advances a version on every observation, because it mutates in place", () => {
      // `observe` mutates the stored AgentState and hands back the SAME reference, so a
      // `useSyncExternalStore` snapshot of `get(paneId)` can never see a change. A counter is the
      // primitive, comparable snapshot that makes this store renderable at all — the same gap that
      // bit `plans/honest-agent-status/` Slice 8's answered mark.
      const registry = createAgentStateRegistry();
      const start = registry.version();

      registry.observe(ev());
      const afterFirst = registry.version();
      registry.observe(ev({ kind: "tool_post", tag: "tool_post_edit" }));

      expect(afterFirst).toBeGreaterThan(start);
      expect(registry.version()).toBeGreaterThan(afterFirst);
    });

    it("notifies subscribers when a pane's facts change", () => {
      const registry = createAgentStateRegistry();
      let calls = 0;
      registry.subscribe(() => {
        calls += 1;
      });

      registry.observe(ev());

      expect(calls).toBe(1);
    });

    it("stops notifying after unsubscribe", () => {
      const registry = createAgentStateRegistry();
      let calls = 0;
      const off = registry.subscribe(() => {
        calls += 1;
      });

      off();
      registry.observe(ev());

      expect(calls).toBe(0);
    });

    it("forgets a pane on clear", () => {
      // A closed node's facts must go. `filesTouched` grows without bound per pane and `areaOf`
      // walks the whole list, so a board that has opened and closed agents all day would carry
      // every path any of them ever touched.
      const registry = createAgentStateRegistry();
      registry.observe(ev({ kind: "tool_post", tag: "tool_post_edit", filePath: "/repo/src/auth/login.ts" }));

      registry.clear("canvas:projA:a1");

      expect(registry.get("canvas:projA:a1")).toBeUndefined();
      expect(registry.all()).toEqual([]);
    });

    it("advances the version on a clear that removed something, and not otherwise", () => {
      const registry = createAgentStateRegistry();
      registry.observe(ev());
      const before = registry.version();

      registry.clear("canvas:projA:a1");
      const afterClear = registry.version();
      registry.clear("never-seen");

      expect(afterClear).toBeGreaterThan(before);
      expect(registry.version()).toBe(afterClear);
    });

    it("lets a reopened pane start from nothing", () => {
      const registry = createAgentStateRegistry();
      registry.observe(ev({ kind: "tool_post", tag: "tool_post_edit", filePath: "/repo/src/auth/a.ts" }));
      registry.clear("canvas:projA:a1");

      registry.observe(ev({ kind: "tool_post", tag: "tool_post_edit", filePath: "/repo/src/web/b.ts" }));

      expect(registry.get("canvas:projA:a1")?.filesTouched).toEqual(["/repo/src/web/b.ts"]);
    });
  });

  describe("where the tool name actually comes from (measured 2026-08-26)", () => {
    it("takes the tool name from tool_pre, which is the only event that carries one", () => {
      // Measured against a real 60-entry transcript ring: every `tool-pre` carried its tool
      // (`Bash`), and every `tool-post` carried the literal default `"Tool"` — `extractToolName`
      // reads `tool_name` and finds nothing on a PostToolUse payload.
      //
      // So deriving `lastTool` from the POST event recorded the string "tool" for every call, which
      // is in no phrase table and rendered as "did something".
      const registry = createAgentStateRegistry();

      registry.observe(ev({ kind: "tool_pre", tag: "tool_bash" }));
      registry.observe(ev({ kind: "tool_post", tag: "tool_post_tool" }));

      expect(registry.get("canvas:projA:a1")?.lastTool).toBe("bash");
    });

    it("clears the running tool on post without forgetting which tool it was", () => {
      const registry = createAgentStateRegistry();

      registry.observe(ev({ kind: "tool_pre", tag: "tool_edit" }));
      registry.observe(ev({ kind: "tool_post", tag: "tool_post_tool" }));

      const state = registry.get("canvas:projA:a1")!;
      expect(state.currentTool).toBeNull();
      expect(state.lastTool).toBe("edit");
    });

    it("still prefers a named post event when one arrives", () => {
      // Codex and future runners may populate it. A named post must not be discarded in favour of
      // an older pre.
      const registry = createAgentStateRegistry();

      registry.observe(ev({ kind: "tool_pre", tag: "tool_bash" }));
      registry.observe(ev({ kind: "tool_post", tag: "tool_post_edit" }));

      expect(registry.get("canvas:projA:a1")?.lastTool).toBe("edit");
    });
  });

  describe("what counts as a touched file", () => {
    it("ignores a tool target that is a command, not a path", () => {
      // `filePath` is `payload.body`, and for Bash that body is the COMMAND
      // (`cd /Users/…/experiments/Lotus`). Today nothing reaches here because a Bash tool-post
      // carries no target at all (measured 2026-08-26) — but if a runner ever populates it, `areaOf`
      // would split the command on "/" and report "experiments" as the agent's area, confidently and
      // wrongly.
      const registry = createAgentStateRegistry();

      registry.observe(
        ev({
          kind: "tool_post",
          tag: "tool_post_bash",
          filePath: "cd /Users/me/workspace/experiments/Lotus && bun run test",
        }),
      );

      expect(registry.get("canvas:projA:a1")?.filesTouched).toEqual([]);
    });

    it("still records a real absolute path", () => {
      const registry = createAgentStateRegistry();

      registry.observe(
        ev({ kind: "tool_post", tag: "tool_post_edit", filePath: "/repo/src/auth/login.ts" }),
      );

      expect(registry.get("canvas:projA:a1")?.filesTouched).toEqual(["/repo/src/auth/login.ts"]);
    });

    it("records a relative path, which Edit and Write both send", () => {
      const registry = createAgentStateRegistry();

      registry.observe(
        ev({ kind: "tool_post", tag: "tool_post_write", filePath: "src/auth/token.ts" }),
      );

      expect(registry.get("canvas:projA:a1")?.filesTouched).toEqual(["src/auth/token.ts"]);
    });
  });
});

describe("turnActive", () => {
  // Added for the 2026-08-26 headline defect. The store knew which tool was running but not whether
  // a TURN was, so the headline composer had no way to tell "between two tools, still working" from
  // "finished". It guessed the first for both, and a done agent kept a present-tense title.

  it("is false until something proves a turn is live", () => {
    // A lone `tool_post` proves a tool FINISHED, not that the turn continues. Defaulting to closed
    // keeps the headline in the past tense, which is the honest reading of an unknown.
    const registry = createAgentStateRegistry();

    const state = registry.observe(ev({ kind: "tool_post", tag: "tool_post_bash" }));

    expect(state.turnActive).toBe(false);
  });

  it("opens on a submitted prompt", () => {
    const registry = createAgentStateRegistry();

    const state = registry.observe(ev({ kind: "prompt_intent", tag: "prompt_intent" }));

    expect(state.turnActive).toBe(true);
  });

  it("opens on a tool starting, for runners whose prompt hook we never see", () => {
    // Not merely defensive: a tool cannot run outside a turn, so `tool_pre` is proof of a live one.
    // Depending on `prompt_intent` alone would leave every pane spawned mid-turn reading as done.
    const registry = createAgentStateRegistry();

    expect(registry.observe(ev({ kind: "tool_pre", tag: "tool_bash" })).turnActive).toBe(true);
  });

  it("stays open between two tools in the same turn", () => {
    // The exact sequence that used to freeze the title: post clears `currentTool`, and only the turn
    // flag can say the agent is still working.
    const registry = createAgentStateRegistry();
    registry.observe(ev({ kind: "tool_pre", tag: "tool_bash" }));

    const state = registry.observe(ev({ kind: "tool_post", tag: "tool_post_bash", ts: NOW + 10 }));

    expect(state.turnActive).toBe(true);
  });

  it("closes when the turn ends", () => {
    const registry = createAgentStateRegistry();
    registry.observe(ev({ kind: "tool_pre", tag: "tool_bash" }));

    const state = registry.observe(ev({ kind: "final", tag: "final", ts: NOW + 20 }));

    expect(state.turnActive).toBe(false);
  });

  it("reopens on the next prompt", () => {
    const registry = createAgentStateRegistry();
    registry.observe(ev({ kind: "tool_pre", tag: "tool_bash" }));
    registry.observe(ev({ kind: "final", tag: "final", ts: NOW + 20 }));

    const state = registry.observe(ev({
      kind: "prompt_intent",
      tag: "prompt_intent",
      ts: NOW + 30,
    }));

    expect(state.turnActive).toBe(true);
  });

  it("leaves a final's prose out of the touched files", () => {
    // `final` now reaches a branch it never used to. Its body is prose, and letting it through would
    // corrupt the area label — the same trap `looksLikePath` guards for Bash commands.
    const registry = createAgentStateRegistry();

    const state = registry.observe(ev({
      kind: "final",
      tag: "final",
      filePath: "/repo/src/auth/login.ts",
    }));

    expect(state.filesTouched).toEqual([]);
  });
});

describe("lastPrompt", () => {
  // The ask is the headline (`plans/agent-headlines/`, design reversed 2026-08-26). It arrives on
  // the prompt drop as `neutral` and used to be dropped on the floor here.

  it("remembers the ask a turn started from", () => {
    const registry = createAgentStateRegistry();

    const state = registry.observe(ev({
      kind: "prompt_intent",
      tag: "prompt_intent",
      neutral: "jelaskan perubahan yang belum commit",
    }));

    expect(state.lastPrompt).toBe("jelaskan perubahan yang belum commit");
  });

  it("is null before any ask is seen", () => {
    const registry = createAgentStateRegistry();

    expect(registry.observe(ev({ kind: "tool_pre", tag: "tool_bash" })).lastPrompt).toBeNull();
  });

  it("keeps the ask across the tools it triggers", () => {
    const registry = createAgentStateRegistry();
    registry.observe(ev({ kind: "prompt_intent", tag: "prompt_intent", neutral: "run the tests" }));

    registry.observe(ev({ kind: "tool_pre", tag: "tool_bash", ts: NOW + 10 }));
    const state = registry.observe(ev({ kind: "final", tag: "final", ts: NOW + 20 }));

    expect(state.lastPrompt).toBe("run the tests");
  });

  it("replaces it on the next ask", () => {
    const registry = createAgentStateRegistry();
    registry.observe(ev({ kind: "prompt_intent", tag: "prompt_intent", neutral: "run the tests" }));

    const state = registry.observe(ev({
      kind: "prompt_intent",
      tag: "prompt_intent",
      neutral: "now fix the lint",
      ts: NOW + 30,
    }));

    expect(state.lastPrompt).toBe("now fix the lint");
  });

  it("ignores an empty ask rather than blanking the one it has", () => {
    // A runner that fires the prompt hook without a payload would otherwise erase a good headline.
    const registry = createAgentStateRegistry();
    registry.observe(ev({ kind: "prompt_intent", tag: "prompt_intent", neutral: "run the tests" }));

    const state = registry.observe(ev({
      kind: "prompt_intent",
      tag: "prompt_intent",
      neutral: "   ",
      ts: NOW + 30,
    }));

    expect(state.lastPrompt).toBe("run the tests");
  });
});

