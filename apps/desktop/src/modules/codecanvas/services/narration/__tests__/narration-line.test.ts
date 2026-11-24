import { describe, expect, it } from "vitest";
import { narrationTemplateLine } from "../narration-line";
import type { NarrationEvent } from "../narration-event";

const NOW = 1_700_000_000_000;

const ev = (over: Partial<NarrationEvent> = {}): NarrationEvent => ({
  kind: "tool_pre",
  tag: "tool_edit",
  neutral: "",
  paneId: "canvas:projA:node-9",
  ts: NOW,
  ...over,
});

describe("narrationTemplateLine — never reads a path aloud", () => {
  it("names the file by its short name, not its path", () => {
    // The shipped bug: `neutral` for a tool event IS the absolute path, and the renderer spoke it
    // verbatim — "src slash modules slash codecanvas slash …". The policy has forbidden this since
    // Slice 0; nothing was applying it.
    const line = narrationTemplateLine(ev({ filePath: "/repo/src/modules/auth/login.ts", neutral: "/repo/src/modules/auth/login.ts" }));

    expect(line).toBe("editing login");
    expect(line).not.toContain("/");
    expect(line).not.toContain(".ts");
  });

  it("speaks in the present while the tool runs, and the past once it returns", () => {
    // Tense encodes state — the difference between a collaborator and a status feed.
    expect(narrationTemplateLine(ev({ kind: "tool_pre", tag: "tool_edit", filePath: "/r/a/auth.ts" }))).toBe("editing auth");
    expect(narrationTemplateLine(ev({ kind: "tool_post", tag: "tool_post_edit", filePath: "/r/a/auth.ts" }))).toBe("edited auth");
  });

  it("drops the file entirely for a tool that touched none", () => {
    expect(narrationTemplateLine(ev({ kind: "tool_pre", tag: "tool_bash" }))).toBe("running a command");
  });

  it("says a failure plainly, with no model in the loop", () => {
    // The load-bearing invariant: a dead API key must never mean a missed regression.
    expect(narrationTemplateLine(ev({ kind: "tool_post", tag: "tool_post_failure", neutral: "exit 1" }))).toBe(
      "that command failed",
    );
  });

  it("still says something for a tool it has never heard of", () => {
    expect(narrationTemplateLine(ev({ kind: "tool_pre", tag: "tool_somethingnew" }))).toBe("working on something");
  });
});

describe("narrationTemplateLine — the long-response case", () => {
  it("never returns the agent's whole reply as the line", () => {
    // A `final`'s body is the agent's entire last message, up to 1000 chars. Speaking it verbatim
    // is what made narration feel like a transcript rather than a summary.
    const wall = "I refactored the auth flow. ".repeat(40);
    const line = narrationTemplateLine(ev({ kind: "final", tag: "final", neutral: wall }));

    expect(line?.length ?? 0).toBeLessThan(120);
    expect(line).toBeTruthy();
    expect(line).not.toBe(wall);
  });

  it("returns null for a prompt — echoing the user's own words back is worse than silence", () => {
    expect(narrationTemplateLine(ev({ kind: "prompt_intent", tag: "prompt_intent", neutral: "fix the auth bug" }))).toBeNull();
  });
});
