import { describe, expect, it } from "vitest";
import { shouldStartDormant } from "../session-dormancy";

describe("shouldStartDormant", () => {
  it("sleeps a node that has a conversation to continue", () => {
    expect(
      shouldStartDormant({
        hasPooledPty: false,
        resumeSessionId: "sess-1",
        capability: { kind: "resume" },
      }),
    ).toBe(true);
  });

  // The rule that outranks everything: a running conversation must never be hidden behind a Resume
  // button, because pressing it would kill the CLI to start an identical one.
  it("never sleeps a node whose PTY is still alive", () => {
    expect(
      shouldStartDormant({
        hasPooledPty: true,
        resumeSessionId: "sess-1",
        capability: { kind: "resume" },
      }),
    ).toBe(false);
  });

  it("starts a node with no prior conversation normally", () => {
    expect(shouldStartDormant({ hasPooledPty: false, capability: { kind: "resume" } })).toBe(false);
    expect(
      shouldStartDormant({
        hasPooledPty: false,
        resumeSessionId: "",
        capability: { kind: "resume" },
      }),
    ).toBe(false);
    expect(
      shouldStartDormant({
        hasPooledPty: false,
        resumeSessionId: null,
        capability: { kind: "resume" },
      }),
    ).toBe(false);
  });

  // Sleeping a node whose runner cannot resume would offer a button that starts a BARE process —
  // the same thing that happens on a normal launch, minus two minutes of waiting.
  it("does not sleep a node whose runner cannot resume", () => {
    expect(
      shouldStartDormant({
        hasPooledPty: false,
        resumeSessionId: "sess-1",
        capability: { kind: "unsupported" },
      }),
    ).toBe(false);
  });

  // The bug this refactor is here for: dormancy used a LOOSER predicate than launch, so a node
  // could sleep, be woken, and then be launched with no resume descriptor at all — the conversation
  // gone, and not one message about it. Taking the capability itself makes the two agree by
  // construction, and `off-by-setting` is exactly the case the old boolean got wrong.
  it("refuses to sleep a node whose resume the user has turned off", () => {
    expect(
      shouldStartDormant({
        hasPooledPty: false,
        resumeSessionId: "sess-1",
        capability: { kind: "off-by-setting" },
      }),
    ).toBe(false);
  });
});
