import { describe, expect, it, vi } from "vitest";
import { startSquadPreset, type PaneOpeners } from "@/modules/workspace-shell/services/preset-start";
import { findPreset, SQUAD_PRESETS } from "@/modules/workspace-shell/services/pane-presets";
import type { PaneKind } from "@/modules/workspace-shell/types";

function openers(overrides: Partial<PaneOpeners> = {}): PaneOpeners {
  let serial = 0;
  const make = (kind: PaneKind) => () => `${kind}-${++serial}`;
  return {
    terminal: make("terminal"),
    thread: make("thread"),
    browser: make("browser"),
    editor: make("editor"),
    ...overrides,
  };
}

describe("starting a squad", () => {
  it("opens one pane per lineup member, in lineup order", () => {
    const workbench = findPreset("workbench");
    expect(workbench).not.toBeNull();

    const { paneIds, skipped } = startSquadPreset(workbench!, openers());

    expect(paneIds).toEqual(["terminal-1", "thread-2", "browser-3"]);
    expect(skipped).toEqual([]);
  });

  it("opens the same kind twice when the lineup asks twice", () => {
    // Fleet runs two parallel executors; a squad that de-duplicated its own lineup would start
    // one of them.
    const fleet = findPreset("fleet");
    const terminal = vi.fn(() => "t");

    const { paneIds } = startSquadPreset(fleet!, openers({ terminal }));

    expect(terminal).toHaveBeenCalledTimes(2);
    expect(paneIds).toHaveLength(fleet!.lineup.length);
  });

  it("skips a member it cannot open and starts the rest", () => {
    // A build with no free-chat template cannot seed a conversation. Losing the terminals as
    // well would turn a partial failure into a total one.
    const workbench = findPreset("workbench");

    const { paneIds, skipped } = startSquadPreset(workbench!, openers({ thread: () => null }));

    // The serial only advances when an opener actually runs, so the browser is the second.
    expect(paneIds).toEqual(["terminal-1", "browser-2"]);
    expect(skipped).toEqual(["thread"]);
  });

  it("reports an empty start rather than pretending something opened", () => {
    const solo = findPreset("solo");

    const { paneIds, skipped } = startSquadPreset(solo!, openers({ terminal: () => null }));

    expect(paneIds).toEqual([]);
    expect(skipped).toEqual(["terminal"]);
  });

  it("has an opener for every kind any preset can ask for", () => {
    // The fence: a lineup kind with no opener is a row the menu shows and cannot start.
    const kinds = new Set(SQUAD_PRESETS.flatMap((preset) => preset.lineup.map((member) => member.kind)));
    const available = openers();
    for (const kind of kinds) {
      expect(typeof available[kind]).toBe("function");
    }
  });
});
