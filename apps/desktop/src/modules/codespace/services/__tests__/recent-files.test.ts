import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetRecentFiles,
  formatRecentAge,
  listRecentFiles,
  moveRecentFiles,
  recordRecentFile,
} from "@/modules/codespace/services/recent-files";

const A = "local|/repo";
const B = "ssh:alwi@vps:|/repo";

describe("recent files", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps each workspace's files apart, newest first, each file once", () => {
    recordRecentFile(A, "/repo/a.ts", 1);
    recordRecentFile(A, "/repo/b.ts", 2);
    recordRecentFile(B, "/repo/remote.ts", 3);
    recordRecentFile(A, "/repo/a.ts", 4);

    expect(listRecentFiles(A)).toEqual([
      { path: "/repo/a.ts", at: 4 },
      { path: "/repo/b.ts", at: 2 },
    ]);
    expect(listRecentFiles(B)).toEqual([{ path: "/repo/remote.ts", at: 3 }]);
  });

  it("keeps the newest 24", () => {
    for (let index = 0; index < 30; index += 1) recordRecentFile(A, `/repo/f${index}.ts`, index);
    const recent = listRecentFiles(A);
    expect(recent).toHaveLength(24);
    expect(recent[0].path).toBe("/repo/f29.ts");
    expect(recent.at(-1)?.path).toBe("/repo/f6.ts");
  });

  it("drops a deleted file, or everything under a deleted folder", () => {
    recordRecentFile(A, "/repo/src/a.ts", 1);
    recordRecentFile(A, "/repo/src/deep/b.ts", 2);
    recordRecentFile(A, "/repo/srcx.ts", 3);
    recordRecentFile(A, "/repo/README.md", 4);

    forgetRecentFiles(A, "/repo/README.md");
    forgetRecentFiles(A, "/repo/src");

    expect(listRecentFiles(A).map((entry) => entry.path)).toEqual(["/repo/srcx.ts"]);
  });

  it("follows a rename", () => {
    recordRecentFile(A, "/repo/src/a.ts", 1);
    recordRecentFile(A, "/repo/other.ts", 2);
    moveRecentFiles(A, "/repo/src", "/repo/lib");
    moveRecentFiles(A, "/repo/other.ts", "/repo/renamed.ts");
    expect(listRecentFiles(A)).toEqual([
      { path: "/repo/renamed.ts", at: 2 },
      { path: "/repo/lib/a.ts", at: 1 },
    ]);
  });

  it("works without storage, and ignores what it cannot read", () => {
    window.localStorage.setItem("lotus:editor-recent:v1:local|/repo", "{not json");
    expect(listRecentFiles(A)).toEqual([]);

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => recordRecentFile(A, "/repo/a.ts", 1)).not.toThrow();
    spy.mockRestore();
  });

  it("says how long ago, briefly", () => {
    const now = new Date("2026-09-29T15:00:00").getTime();
    const min = 60_000;
    expect(formatRecentAge(now - 20_000, now)).toBe("now");
    expect(formatRecentAge(now - 14 * min, now)).toBe("14 min");
    expect(formatRecentAge(now - 65 * min, now)).toBe("1 h");
    expect(formatRecentAge(new Date("2026-09-28T09:00:00").getTime(), now)).toBe("yesterday");
    expect(formatRecentAge(new Date("2026-09-27T09:00:00").getTime(), now)).toBe("2 d");
    expect(formatRecentAge(new Date("2026-08-01T09:00:00").getTime(), now)).toBe("8 w");
  });
});
