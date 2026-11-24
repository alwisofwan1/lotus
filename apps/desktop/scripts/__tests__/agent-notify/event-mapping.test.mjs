import { describe, it, expect } from "vitest";
import { mapEventToStatus } from "../../agent-notify/event-mapping.mjs";

describe("mapEventToStatus — tool events for narration", () => {
  // Tool drops must be invisible to the OTHER consumer of this stream. Codespace's
  // useAgentHookEvents filters on status alone and reads "idle" as "the agent completed" and
  // "error" as "the agent failed" — so a tool drop carrying either would mislabel the whole agent
  // on every tool call. "running" is the one status that consumer skips.
  it.each(["tool-pre", "tool-post", "tool-post-failed"])("keeps %s at running status", (event) => {
    expect(mapEventToStatus(event).status).toBe("running");
  });

  it("titles a tool event generically — the real title is the tool name, filled in by the caller", () => {
    expect(mapEventToStatus("tool-pre").defaultTitle).toBe("Tool");
  });
});

describe("mapEventToStatus", () => {
  it("maps stop-family events to idle", () => {
    expect(mapEventToStatus("stop")).toEqual({
      status: "idle",
      defaultTitle: "Finished working",
    });
    expect(mapEventToStatus("agent-response")).toEqual({
      status: "idle",
      defaultTitle: "Finished working",
    });
    expect(mapEventToStatus("after-agent")).toEqual({
      status: "idle",
      defaultTitle: "Finished working",
    });
  });

  it("maps notification/needs-input to needs-input", () => {
    expect(mapEventToStatus("notification")).toEqual({
      status: "needs-input",
      defaultTitle: "Needs input",
    });
    expect(mapEventToStatus("needs-input")).toEqual({
      status: "needs-input",
      defaultTitle: "Needs input",
    });
  });

  it("maps error to error", () => {
    expect(mapEventToStatus("error")).toEqual({
      status: "error",
      defaultTitle: "Error",
    });
  });

  it("maps start-family events to running", () => {
    expect(mapEventToStatus("session-start")).toEqual({
      status: "running",
      defaultTitle: "Working",
    });
    // `running` like the rest of the family — codespace filters this stream on status
    // alone, and a turn beginning is neither a completion nor a failure. The title is
    // the exception: this is the one event whose body is the operator's own words.
    expect(mapEventToStatus("prompt-submit")).toEqual({
      status: "running",
      defaultTitle: "You",
    });
    expect(mapEventToStatus("before-agent")).toEqual({
      status: "running",
      defaultTitle: "Working",
    });
  });

  it("maps session-end to ended", () => {
    expect(mapEventToStatus("session-end")).toEqual({
      status: "ended",
      defaultTitle: "Session ended",
    });
  });

  it("maps unknown events to idle/Update fallback", () => {
    expect(mapEventToStatus("totally-made-up")).toEqual({
      status: "idle",
      defaultTitle: "Update",
    });
    expect(mapEventToStatus("")).toEqual({
      status: "idle",
      defaultTitle: "Update",
    });
  });

  it("is case-insensitive on the event name", () => {
    expect(mapEventToStatus("STOP")).toEqual({
      status: "idle",
      defaultTitle: "Finished working",
    });
    expect(mapEventToStatus("Notification")).toEqual({
      status: "needs-input",
      defaultTitle: "Needs input",
    });
  });

  it("trims whitespace from event name", () => {
    expect(mapEventToStatus("  stop  ")).toEqual({
      status: "idle",
      defaultTitle: "Finished working",
    });
  });
});
