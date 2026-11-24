import { describe, expect, it } from "vitest";
import { readWorktreeCleanupSettings, restoreCommand, type WorktreeRow } from "@/lib/tauri/worktree-cleanup";
import { formatAge, formatSize, summarize } from "../sections/WorktreesSection";

const row = (over: Partial<WorktreeRow>): WorktreeRow => ({
  path: "/r-x", branch: "x", sha: "abc", repo: "/r", kind: "yours", state: "clean",
  reason: null, blocked: null, sizeBytes: 1024 ** 3, lastActiveMs: 0, ...over,
});

describe("Settings › Worktrees", () => {
  it("the auto rule is off by default and days stay 1–90", () => {
    expect(readWorktreeCleanupSettings({})).toEqual({ auto: false, days: 7 });
    expect(readWorktreeCleanupSettings({ worktreeCleanup: { auto: true, days: 500 } })).toEqual({ auto: true, days: 90 });
    expect(readWorktreeCleanupSettings({ worktreeCleanup: { days: 0 } }).days).toBe(1);
  });

  it("safe to remove means not blocked and no work", () => {
    const rows = [row({}), row({ path: "/a", state: "merged" }), row({ path: "/b", state: "hasWork" }), row({ path: "/c", blocked: "In use" })];
    const s = summarize(rows);
    expect(s.count).toBe(4);
    expect(s.safe.map((r) => r.path)).toEqual(["/r-x", "/a"]);
    expect(formatSize(s.safeBytes)).toBe("2 GB");
  });

  it("age and restore command", () => {
    const now = 10 * 86_400_000;
    expect(formatAge(0, now)).toBe("");
    expect(formatAge(now - 60_000, now)).toBe("now");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3 h");
    expect(formatAge(now * 3 - 21 * 86_400_000, now * 3)).toBe("21 d");
    expect(restoreCommand({ atMs: 0, path: "/r-x", repo: "/r", branch: "x", sha: "abc", hadWork: false, auto: false })).toBe('git -C "/r" branch x abc');
    expect(restoreCommand({ atMs: 0, path: "/r-x", repo: "/r", branch: null, sha: "abc", hadWork: false, auto: false })).toBeNull();
  });
});
