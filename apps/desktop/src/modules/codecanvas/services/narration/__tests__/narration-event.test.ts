import { describe, expect, it } from "vitest";
import { toNarrationEvent, type AgentHookDropPayload } from "../narration-event";

const drop = (over: Partial<AgentHookDropPayload>): AgentHookDropPayload => ({
  version: 1,
  sessionId: "s1",
  agentType: "claude",
  event: "stop",
  status: "idle",
  title: "",
  body: "",
  userPrompt: "",
  cwd: "/repo",
  pid: null,
  agentPid: null,
  paneId: "canvas:projA:a1",
  timestamp: 1_700_000_000_000,
  ...over,
});

describe("toNarrationEvent", () => {
  it("maps a tool-pre drop to an in-flight narration event", () => {
    const event = toNarrationEvent(drop({ event: "tool-pre", status: "running", title: "Edit", body: "src/auth.ts" }));

    expect(event).toMatchObject({
      kind: "tool_pre",
      neutral: "src/auth.ts",
      paneId: "canvas:projA:a1",
      ts: 1_700_000_000_000,
    });
  });

  it.each([
    ["prompt-submit", "prompt_intent"],
    ["stop", "final"],
    ["tool-post", "tool_post"],
  ])("maps the %s hook event to the %s narration kind", (hookEvent, kind) => {
    expect(toNarrationEvent(drop({ event: hookEvent }))?.kind).toBe(kind);
  });

  it.each(["notification", "session-start", "session-end", "before-agent", ""])(
    "ignores the %s hook event — not something narration speaks about",
    (hookEvent) => {
      // The drop directory carries every hook the CLI fires, including lifecycle noise. Narration
      // subscribes to the same stream, so the filter has to live here.
      expect(toNarrationEvent(drop({ event: hookEvent }))).toBeNull();
    },
  );

  it("tags a failed tool result as a failure — the tag the pierce rule keys on", () => {
    // Every downstream layer decides "must the user hear this?" from the tag. Getting this one
    // wrong means a regression goes by silently, which is the failure mode narration exists to stop.
    const event = toNarrationEvent(drop({ event: "tool-post-failed", title: "Bash", body: "exit 1" }));

    expect(event?.tag).toBe("tool_post_failure");
    expect(event?.kind).toBe("tool_post");
  });

  it("reads failure from the event name, never from `status`", () => {
    // `status` is load-bearing for a DIFFERENT consumer: codespace's useAgentHookEvents maps
    // status "error" → the agent FAILED and "idle" → the agent COMPLETED, filtering on status
    // alone and never on the event name. A tool event carrying either would mislabel the whole
    // agent on every tool call, so tool drops are always status "running" and the failure signal
    // lives in the event name instead.
    expect(toNarrationEvent(drop({ event: "tool-post", status: "error" }))?.tag).not.toBe("tool_post_failure");
    expect(toNarrationEvent(drop({ event: "tool-post-failed", status: "running" }))?.tag).toBe("tool_post_failure");
  });

  it.each([
    ["tool-pre", "idle", "Edit", "tool_edit"],
    ["tool-pre", "idle", "Bash", "tool_bash"],
    ["tool-post", "idle", "Edit", "tool_post_edit"],
    ["prompt-submit", "running", "", "prompt_intent"],
    ["stop", "idle", "", "final"],
  ])("tags a %s/%s/%s drop as %s", (hookEvent, status, title, tag) => {
    expect(toNarrationEvent(drop({ event: hookEvent, status, title }))?.tag).toBe(tag);
  });

  it("falls back to a generic tool tag rather than an empty one for an unnamed tool", () => {
    expect(toNarrationEvent(drop({ event: "tool-pre", title: "" }))?.tag).toBe("tool_unknown");
  });

  it("surfaces the touched file as its own field, not just as free text", () => {
    // The agent-state layer counts files touched and derives a per-agent AREA label from their
    // parent directories. Reading that back out of `neutral` by shape-guessing would be fragile.
    const event = toNarrationEvent(drop({ event: "tool-pre", title: "Edit", body: "/repo/src/auth.ts" }));

    expect(event?.filePath).toBe("/repo/src/auth.ts");
  });

  it("leaves filePath unset when the tool touched no file", () => {
    expect(toNarrationEvent(drop({ event: "tool-pre", title: "Bash", body: "" }))?.filePath).toBeUndefined();
  });

  it("never reads a file path out of a non-tool event", () => {
    // A `final`'s body is prose, and a prompt's is the user's words. Neither is a path, and
    // treating one as a touched file would corrupt the area label.
    expect(toNarrationEvent(drop({ event: "stop", body: "I finished the refactor" }))?.filePath).toBeUndefined();
  });

  it("carries the user's prompt as the neutral text for a prompt-submit", () => {
    // For this one kind the substance is in `userPrompt`, not `body` — body is empty at submit time.
    const event = toNarrationEvent(drop({ event: "prompt-submit", userPrompt: "fix the auth flow", body: "" }));

    expect(event?.neutral).toBe("fix the auth flow");
  });
});
