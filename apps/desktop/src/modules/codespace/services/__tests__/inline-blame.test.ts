import { describe, expect, it } from "vitest";
import type { GitBlameEntry } from "@/lib/tauri/project-files";
import { blameAge, blameAt, blameHover, blameInline, blameStatus } from "../inline-blame";

const NOW = Date.UTC(2026, 10, 21, 12, 0);
const at = (ms: number) => Math.floor((NOW - ms) / 1000);
const entry = (over: Partial<GitBlameEntry> = {}): GitBlameEntry => ({
  lineNumber: 1,
  commit: "23855d83",
  author: "Rina Hartono",
  timestamp: at(2 * 3600_000),
  summary: "fix(chat): keep a note",
  committed: true,
  you: false,
  ...over,
});

describe("inline blame words", () => {
  it("says a short age, then the date past a year", () => {
    expect(blameAge(at(10_000), NOW)).toBe("now");
    expect(blameAge(at(5 * 60_000), NOW)).toBe("5m ago");
    expect(blameAge(at(3 * 86_400_000), NOW)).toBe("3d ago");
    expect(blameAge(at(120 * 86_400_000), NOW)).toBe("4mo ago");
    expect(blameAge(at(400 * 86_400_000), NOW)).toMatch(/^2025-\d\d-\d\d$/);
  });

  it("names you, and lines not committed", () => {
    expect(blameInline(entry({ you: true }), NOW)).toBe("You · 2h ago · fix(chat): keep a note");
    expect(blameStatus(entry(), NOW)).toBe("Rina Hartono · 2h ago");
    expect(blameInline(entry({ committed: false }), NOW)).toBe("Not committed yet");
    expect(blameHover(entry({ committed: false }), NOW)).toBeNull();
    expect(blameHover(entry(), NOW)).toContain("`23855d83`");
  });

  it("finds a line's entry", () => {
    const entries = [entry(), entry({ lineNumber: 2, commit: "b" })];
    expect(blameAt(entries, 2)?.commit).toBe("b");
    expect(blameAt(entries, 3)).toBeNull();
  });
});
