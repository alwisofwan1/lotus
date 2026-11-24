import { describe, expect, it } from "vitest";
import {
  describeLineup,
  findPreset,
  PANE_OPTIONS,
  panesLabel,
  runnerCount,
  sessionCount,
  SQUAD_PRESETS,
} from "@/modules/workspace-shell/services/pane-presets";
import { paneShortcutKind } from "@/modules/workspace-shell/services/shortcuts";

describe("pane options", () => {
  it("offers every pane kind exactly once", () => {
    const kinds = PANE_OPTIONS.map((option) => option.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    // Four, since the Bridge pane was retired with CodeSpace.
    expect(kinds).toEqual(["terminal", "thread", "browser", "editor"]);
  });

  it("gives each option a shortcut to advertise", () => {
    expect(PANE_OPTIONS.every((option) => option.shortcut.length > 0)).toBe(true);
  });

  /**
   * The fence that keeps the menu honest.
   *
   * These chords were printed for weeks with nothing behind them, and one of them — ⌘B on the
   * Browser row — belonged to the rail toggle, so the row advertised a key that collapsed the
   * sidebar. Reading each printed chord back through the predicate that actually runs is the only
   * way the two cannot drift apart again.
   */
  it("prints only chords that really open that pane", () => {
    for (const option of PANE_OPTIONS) {
      const event = {
        key: option.shortcut.replace(/[⌘⇧]/g, ""),
        metaKey: option.shortcut.includes("⌘"),
        ctrlKey: false,
        shiftKey: option.shortcut.includes("⇧"),
        altKey: false,
      };
      expect([option.label, paneShortcutKind(event, "MacIntel")]).toEqual([option.label, option.kind]);
    }
  });
});

describe("how a count is printed", () => {
  it("does not say \"1 panes\"", () => {
    // English will not let a number carry its own plural, and the menu prints this three times.
    expect(panesLabel(1)).toBe("1 pane");
    expect(panesLabel(3)).toBe("3 panes");
  });
});

describe("squad presets", () => {
  it("has a unique id per preset", () => {
    const ids = SQUAD_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never offers an empty lineup — a preset that starts nothing is a dead button", () => {
    expect(SQUAD_PRESETS.every((preset) => preset.lineup.length > 0)).toBe(true);
  });

  it("grows monotonically, so the list reads as a scale", () => {
    const counts = SQUAD_PRESETS.map(sessionCount);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it("counts runners apart from surfaces", () => {
    const workbench = findPreset("workbench");
    expect(workbench).not.toBeNull();
    expect(sessionCount(workbench!)).toBe(3);
    // The browser is a surface: it opens, it does not spend an agent.
    expect(runnerCount(workbench!)).toBe(2);
  });

  it("describes what the button is about to spend", () => {
    expect(describeLineup(findPreset("solo")!)).toBe("1 agent");
    expect(describeLineup(findPreset("workbench")!)).toBe("2 agents · 1 surface");
  });

  it("returns null for an id that is not a preset", () => {
    expect(findPreset("swarm")).toBeNull();
  });
});
