import { describe, it, expect } from "vitest";
import { DEFAULT_VOICE_INPUT } from "../voice-mode";

// The finalized-transcript decision moved to the Voice Intent Router (voice-intent-router.test.ts);
// voice-mode.ts now holds just the shared types + persisted defaults.
describe("voice-mode defaults", () => {
  it("ships command-first, auto-submit-on, polish-on, auto-cleanup-off defaults", () => {
    expect(DEFAULT_VOICE_INPUT).toEqual({
      autoSubmit: true, minWordsToSubmit: 2, polish: true, autoCleanup: false, dictationMode: "clean", sendRightAway: false,
    });
  });
});
