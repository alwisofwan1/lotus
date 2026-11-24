import { describe, expect, it } from "vitest";
import { codeModeStatusLabel } from "@/modules/workspace-shell/services/mode-status";

/**
 * The pill used to read `livePaneCount` alone, which counts terminals with a live PTY. With two
 * conversations open and no terminal it said "0 sesi hidup" — literally true, and a lie as a
 * sentence (observed 2026-09-20 in the native window).
 */
describe("codeModeStatusLabel", () => {
  it("counts conversations, which are not PTY sessions", () => {
    expect(codeModeStatusLabel({ terminals: 0, liveTerminals: 0, chatPanes: 2 })).toBe("2 threads");
  });

  it("names both kinds when both are open", () => {
    expect(codeModeStatusLabel({ terminals: 2, liveTerminals: 2, chatPanes: 1 })).toBe(
      "2 terminals live · 1 thread",
    );
  });

  it("says a terminal is idle rather than calling it live", () => {
    expect(codeModeStatusLabel({ terminals: 2, liveTerminals: 0, chatPanes: 0 })).toBe("2 terminals idle");
  });

  it("counts only the live ones when some terminals are idle", () => {
    expect(codeModeStatusLabel({ terminals: 3, liveTerminals: 1, chatPanes: 0 })).toBe("1 terminal live");
  });

  it("says plainly when the workspace is empty", () => {
    expect(codeModeStatusLabel({ terminals: 0, liveTerminals: 0, chatPanes: 0 })).toBe("No panes yet");
  });
});

/**
 * An inventory answers a question nobody asks twice. The moment something is happening, THAT is
 * the sentence the title bar has room for.
 */
describe("what the pill says once something is happening", () => {
  const inventory = { terminals: 3, liveTerminals: 3, chatPanes: 2 };

  it("leads with the ask, because it is the only count that is a request", () => {
    expect(codeModeStatusLabel({ ...inventory, working: 2, needsYou: 1 })).toBe(
      "1 need you · 2 working",
    );
  });

  it("does not hide the work behind the ask", () => {
    // Dropping the working count would make a busy workspace look stalled behind one prompt.
    expect(codeModeStatusLabel({ ...inventory, working: 0, needsYou: 2 })).toBe("2 need you");
  });

  it("states the work alone when nobody is waiting", () => {
    expect(codeModeStatusLabel({ ...inventory, working: 3, needsYou: 0 })).toBe("3 working");
  });

  it("falls back to the inventory when everything is at rest", () => {
    expect(codeModeStatusLabel({ ...inventory, working: 0, needsYou: 0 })).toBe(
      "3 terminals live · 2 threads",
    );
  });
});

describe("codeModeStatusLabel — unread results", () => {
  const inventory = { terminals: 2, liveTerminals: 2, chatPanes: 0 };

  it("names finished results nobody has opened, after asks and before progress", () => {
    expect(codeModeStatusLabel({ ...inventory, needsYou: 1, unread: 2, working: 1 })).toBe(
      "1 need you · 2 done · 1 working",
    );
  });

  it("says it on its own when that is all that is happening", () => {
    expect(codeModeStatusLabel({ ...inventory, unread: 1 })).toBe("1 done");
  });
});
