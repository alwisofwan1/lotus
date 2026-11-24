import { describe, it, expect, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { buildCommandSheetItems, filterCommandSheetItems, GROUP_LABEL } from "../command-sheet-items";

const runs = [
  { repo: "o/r", issue: 6, title: "Exit lifecycle", statusWord: "Working" },
  { repo: "o/r", issue: 7, title: "Audio ding", statusWord: "Needs you" },
];
const factoryRows = (items: ReturnType<typeof buildCommandSheetItems>) => items.filter((item) => item.group === "factory");

describe("placing a Factory Run from ⌘K (#146)", () => {
  it("offers each run under Factory run…, and a row places that run", () => {
    const onAddFactoryRun = vi.fn();
    const rows = factoryRows(buildCommandSheetItems({ nodes: [], clis: [], factoryRuns: runs, onAddFactoryRun }));
    expect(GROUP_LABEL.factory).toBe("Factory run…");
    expect(rows.map((r) => r.title)).toEqual(["Factory run: #6 Exit lifecycle", "Factory run: #7 Audio ding"]);
    expect(rows[1].detail).toBe("o/r · Needs you");
    const action = rows[0].action;
    if (action.kind === "custom") action.run();
    expect(onAddFactoryRun).toHaveBeenCalledWith(runs[0]);
  });

  it("finds a run by typing factory", () => {
    const items = buildCommandSheetItems({ nodes: [], clis: [], factoryRuns: runs, onAddFactoryRun: vi.fn() });
    expect(filterCommandSheetItems(items, "factory audio")[0].title).toBe("Factory run: #7 Audio ding");
  });

  it("does not offer a run already on the canvas", () => {
    const onBoard = { id: "f", type: "factory", position: { x: 0, y: 0 }, data: { repo: "O/R", issue: 6, title: "x" } } as Node;
    const rows = factoryRows(buildCommandSheetItems({ nodes: [onBoard], clis: [], factoryRuns: runs, onAddFactoryRun: vi.fn() }));
    expect(rows.map((r) => r.title)).toEqual(["Factory run: #7 Audio ding"]);
  });

  it("shows nothing when the canvas cannot place a run", () => {
    expect(factoryRows(buildCommandSheetItems({ nodes: [], clis: [], factoryRuns: runs }))).toEqual([]);
  });
});
