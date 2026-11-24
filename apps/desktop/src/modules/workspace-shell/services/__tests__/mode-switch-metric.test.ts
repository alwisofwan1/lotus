import { describe, expect, it, vi } from "vitest";
import {
  createModeSwitchClock,
  summarizeModeSwitches,
  type ModeSwitchSample,
} from "@/modules/workspace-shell/services/mode-switch-metric";

describe("createModeSwitchClock", () => {
  it("stops the clock on the frame after the switch, not on the call", () => {
    let clock = 0;
    // `!` rather than `| null`: TypeScript narrows the assignment made inside the callback away,
    // and the call below would be typed as calling `null`.
    let frame!: () => void;
    const report = vi.fn();
    const mark = createModeSwitchClock({
      now: () => clock,
      scheduleFrame: (callback) => {
        frame = callback;
      },
      report,
    });

    mark("code", "chat", true, "2 terminals live · 1 thread");
    expect(report).not.toHaveBeenCalled();

    clock = 42;
    frame();

    expect(report).toHaveBeenCalledWith({
      from: "code",
      to: "chat",
      ms: 42,
      firstBuild: true,
      contents: "2 terminals live · 1 thread",
    });
  });
});

describe("summarizeModeSwitches", () => {
  it("reports the spread, because one slow switch is the whole complaint", () => {
    const samples: ModeSwitchSample[] = [8, 9, 10, 11, 120].map((ms) => ({
      from: "code",
      to: "chat",
      ms,
      firstBuild: false,
    }));

    expect(summarizeModeSwitches(samples)).toEqual({ count: 5, min: 8, p50: 10, p95: 120, max: 120 });
  });

  it("does not invent numbers when nothing was measured", () => {
    expect(summarizeModeSwitches([])).toEqual({ count: 0, min: 0, p50: 0, p95: 0, max: 0 });
  });
});
