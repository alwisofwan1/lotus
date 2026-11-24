import { describe, expect, it } from "vitest";
import { chipAccount, resetIn, usageTone, weeklyWindow, windowLabel, windowPace, type UsageAccount, type UsageWindow } from "../usage";

const win = (over: Partial<UsageWindow>): UsageWindow => ({
  kind: "session",
  group: "session",
  usedPercent: 0,
  resetsAtMs: null,
  windowMinutes: 300,
  ...over,
});

const account = (over: Partial<UsageAccount>): UsageAccount => ({
  provider: "claude",
  account: "a",
  plan: null,
  inUse: false,
  windows: [],
  error: null,
  ...over,
});

describe("usage", () => {
  it("labels Claude and Codex windows alike", () => {
    expect(windowLabel(win({}))).toBe("5-hour");
    expect(windowLabel(win({ kind: "primary" }))).toBe("5-hour");
    expect(windowLabel(win({ kind: "weekly_all", group: "weekly" }))).toBe("Weekly");
    expect(windowLabel(win({ kind: "secondary", group: "weekly" }))).toBe("Weekly");
    expect(windowLabel(win({ kind: "weekly_scoped", group: "weekly", scope: "Fable" }))).toBe("Fable");
    expect(windowLabel(win({ kind: "weekly_opus", group: "weekly" }))).toBe("Opus");
  });

  it("paces by time elapsed in the window", () => {
    const now = 1_000_000_000;
    expect(windowPace(win({ resetsAtMs: now + 150 * 60_000 }), now)).toBeCloseTo(0.5);
    expect(windowPace(win({ resetsAtMs: now - 1 }), now)).toBe(1);
    expect(windowPace(win({}), now)).toBeNull();
  });

  it("says a near reset as a countdown and a far one with its day", () => {
    const now = Date.UTC(2026, 10, 6, 12);
    expect(resetIn(now + 232 * 60_000, now)).toBe("in 3h 52m");
    expect(resetIn(now + 30_000, now)).toBe("in 1m");
    expect(resetIn(now + 2 * 86_400_000, now)).toMatch(/\d/);
    expect(resetIn(null, now)).toBe("");
  });

  it("turns warn at 80 and full at 100", () => {
    expect([usageTone(79), usageTone(80), usageTone(100)]).toEqual(["ok", "warn", "full"]);
  });

  it("speaks for the account in use, else the first with numbers", () => {
    const weekly = win({ kind: "weekly_all", group: "weekly", usedPercent: 15 });
    const broken = account({ account: "x", error: "sign-in expired" });
    const good = account({ account: "y", windows: [win({}), weekly] });
    expect(chipAccount([broken, good])?.account).toBe("y");
    expect(chipAccount([good, { ...broken, inUse: true }])?.account).toBe("x");
    expect(weeklyWindow(good)?.usedPercent).toBe(15);
    expect(weeklyWindow(broken)).toBeUndefined();
  });
});
