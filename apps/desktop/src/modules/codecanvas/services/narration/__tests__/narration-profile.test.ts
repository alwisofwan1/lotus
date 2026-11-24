import { describe, expect, it } from "vitest";
import { DEFAULT_NARRATION_PROFILE, shouldNarrate } from "../narration-profile";
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

describe("shouldNarrate — the default profile", () => {
  it("defaults to the balanced profile, not the loudest one", () => {
    expect(DEFAULT_NARRATION_PROFILE).toBe("normal");
  });

  it("says what an agent is starting", () => {
    expect(shouldNarrate(ev({ kind: "tool_pre", tag: "tool_edit" }), "normal")).toBe(true);
  });

  it("stays quiet when a tool merely succeeded", () => {
    // The user's report: "every single step is spoken". Announcing both the start and the finish of
    // every call is double the words for no extra information — the finish only matters when it
    // went wrong.
    expect(shouldNarrate(ev({ kind: "tool_post", tag: "tool_post_edit" }), "normal")).toBe(false);
  });

  it("always says a failure, in every profile", () => {
    // The load-bearing invariant. A verbosity setting must never be able to hide a regression.
    for (const profile of ["quiet", "normal", "verbose"] as const) {
      expect(shouldNarrate(ev({ kind: "tool_post", tag: "tool_post_failure" }), profile)).toBe(true);
    }
  });

  it("always reports the end of a turn", () => {
    for (const profile of ["quiet", "normal", "verbose"] as const) {
      expect(shouldNarrate(ev({ kind: "final", tag: "final" }), profile)).toBe(true);
    }
  });
});

describe("shouldNarrate — quiet and verbose", () => {
  it("quiet drops routine work entirely, keeping only what needs a human", () => {
    expect(shouldNarrate(ev({ kind: "tool_pre", tag: "tool_edit" }), "quiet")).toBe(false);
    expect(shouldNarrate(ev({ kind: "tool_pre", tag: "tool_read" }), "quiet")).toBe(false);
    expect(shouldNarrate(ev({ kind: "prompt_intent", tag: "prompt_intent" }), "quiet")).toBe(true);
  });

  it("quiet still speaks the milestones a long job is judged by", () => {
    // Cutting noise must not mean cutting the two events people actually wait on.
    expect(shouldNarrate(ev({ kind: "tool_pre", tag: "tool_bash", neutral: "" }), "quiet")).toBe(false);
    expect(shouldNarrate(ev({ kind: "tool_pre", tag: "tool_task" }), "quiet")).toBe(true);
  });

  it("verbose says everything, including successful finishes", () => {
    expect(shouldNarrate(ev({ kind: "tool_post", tag: "tool_post_edit" }), "verbose")).toBe(true);
    expect(shouldNarrate(ev({ kind: "tool_pre", tag: "tool_read" }), "verbose")).toBe(true);
  });
});
