import { describe, expect, it } from "vitest";
import { createTerminalModeTracker } from "../terminal-mode-state";

describe("terminal-mode-state", () => {
  it("replays bracketed-paste enable seen in the output stream", () => {
    const tracker = createTerminalModeTracker();
    tracker.observe("\x1b[?2004h\x1b[?25l some TUI banner");

    expect(tracker.replaySequence()).toBe("\x1b[?2004h");
  });

  it("replays nothing when no tracked mode was enabled", () => {
    const tracker = createTerminalModeTracker();
    tracker.observe("plain output, no modes");

    expect(tracker.replaySequence()).toBe("");
  });

  it("drops a mode disabled later in the stream", () => {
    const tracker = createTerminalModeTracker();
    tracker.observe("\x1b[?2004h\x1b[?1004h");
    tracker.observe("shutting down \x1b[?2004l");

    expect(tracker.replaySequence()).toBe("\x1b[?1004h");
  });

  it("tracks multi-parameter DECSET and ignores frame-scoped/untracked modes", () => {
    const tracker = createTerminalModeTracker();
    // Mouse tracking + SGR encoding enabled in one sequence; sync-output (2026),
    // alt-screen (1049) and cursor visibility (25) must not be replayed.
    tracker.observe("\x1b[?1002;1006h\x1b[?2026h\x1b[?1049h\x1b[?25l");

    expect(tracker.replaySequence()).toBe("\x1b[?1002h\x1b[?1006h");
  });
});
