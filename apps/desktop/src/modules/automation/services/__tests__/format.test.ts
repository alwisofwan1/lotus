import { describe, expect, it } from "vitest";

import { describeCron, formatDuration, formatWhen, splitSimpleCron } from "../format";

describe("describeCron", () => {
  it("reads a daily time on weekdays the way bb does", () => {
    expect(describeCron("0 17 * * 1-5")).toBe("5PM Mon-Fri");
    expect(describeCron("0 17 * * 1,2,3,4,5")).toBe("5PM Mon-Fri");
    expect(describeCron("30 9 * * 1,3,5")).toBe("9:30AM Mon, Wed, Fri");
  });

  it("says daily, weekends, noon and midnight plainly", () => {
    expect(describeCron("0 9 * * *")).toBe("9AM daily");
    expect(describeCron("0 12 * * 0,6")).toBe("12PM Sat, Sun");
    expect(describeCron("0 0 * * 1")).toBe("12AM Mon");
    expect(describeCron("0 8 * * 1,2,3,5")).toBe("8AM Mon-Wed, Fri");
  });

  it("reads a repeating interval", () => {
    expect(describeCron("*/2 * * * *")).toBe("Every 2 min");
    expect(describeCron("0 */3 * * *")).toBe("Every 3 hours");
  });

  it("gives up honestly on anything else", () => {
    expect(describeCron("0 9 1 * *")).toBe("Custom schedule");
    expect(describeCron("nonsense")).toBe("Custom schedule");
  });
});

describe("splitSimpleCron", () => {
  it("turns a days-and-time cron back into the form's fields", () => {
    expect(splitSimpleCron("0 9 * * 1,2,3,4,5")).toEqual({ days: ["mon", "tue", "wed", "thu", "fri"], time: "09:00" });
    expect(splitSimpleCron("5 17 * * 0,6")).toEqual({ days: ["sat", "sun"], time: "17:05" });
    expect(splitSimpleCron("0 9 * * *")).toEqual({
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      time: "09:00",
    });
  });

  it("returns null when only a raw cron can describe it", () => {
    expect(splitSimpleCron("*/2 * * * *")).toBeNull();
    expect(splitSimpleCron("0 9 1 * *")).toBeNull();
  });
});

describe("formatWhen and formatDuration", () => {
  it("prints a short date and time", () => {
    const at = new Date(2026, 8, 26, 9, 0).getTime();
    expect(formatWhen(at)).toMatch(/Sep 26.*9:00/);
  });

  it("keeps durations short", () => {
    expect(formatDuration(3_240)).toBe("3.2s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(185_000)).toBe("3m 5s");
    expect(formatDuration(3_840_000)).toBe("1h 4m");
  });
});
