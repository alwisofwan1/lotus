import { describe, expect, it } from "vitest";
import { resumeCapability } from "../session-resume-capability";

describe("resumeCapability", () => {
  // The case the refactor exists for: a custom runner declares its own `{id}` template (Session
  // Widget, Slice 06), so it CAN continue a conversation even though the built-in table says no.
  it("grants resume to a custom runner that declares its own template", () => {
    expect(
      resumeCapability("custom", { resume_template: "--resume {id}", resume_on_reopen: true }),
    ).toEqual({ kind: "resume" });
  });

  // A union, not a boolean, precisely so the UI can tell "cannot" apart from "you turned it off":
  // the first has no cure, the second is one toggle away.
  it("separates a runner the user silenced from one that never could resume", () => {
    expect(resumeCapability("claude", { resume_on_reopen: false })).toEqual({
      kind: "off-by-setting",
    });
    expect(resumeCapability("custom", { resume_on_reopen: true })).toEqual({
      kind: "unsupported",
    });
  });
});
