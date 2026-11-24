import { describe, expect, it } from "vitest";

import {
  clampWorkbenchWidth,
  DEFAULT_WORKBENCH,
  parseWorkbenches,
  patchWorkbench,
  showTab,
  workbenchOf,
  WORKBENCH_TTL_MS,
} from "../workbench";

const NOW = 1_800_000_000_000;

describe("workbench", () => {
  it("gives each thread its own panel, the default until it is touched", () => {
    const all = patchWorkbench({}, "a", { open: true, tab: "files", width: 500 }, NOW);
    expect(workbenchOf(all, "a")).toMatchObject({ open: true, tab: "files", width: 500, at: NOW });
    expect(workbenchOf(all, "b")).toBe(DEFAULT_WORKBENCH);
    expect(workbenchOf(all, null)).toBe(DEFAULT_WORKBENCH);
  });

  it("opens wide for the first Preview in a thread only", () => {
    let all = showTab({}, "a", "preview", NOW);
    expect(workbenchOf(all, "a")).toMatchObject({ open: true, tab: "preview", wide: true, previewSeen: true });
    all = patchWorkbench(all, "a", { wide: false }, NOW);
    all = showTab(all, "a", "changes", NOW);
    all = showTab(all, "a", "preview", NOW);
    expect(workbenchOf(all, "a").wide).toBe(false);
  });

  it("reads back what was stored, dropping stale and malformed entries", () => {
    const stored = JSON.stringify({
      fresh: { open: true, tab: "runs", width: 480, wide: false, previewSeen: true, at: NOW - 1000 },
      stale: { open: true, tab: "files", at: NOW - WORKBENCH_TTL_MS - 1 },
      odd: { open: "yes", tab: "nope", width: "wide", at: NOW },
      junk: 3,
    });
    const all = parseWorkbenches(stored, NOW);
    expect(Object.keys(all).sort()).toEqual(["fresh", "odd"]);
    expect(all.fresh).toMatchObject({ open: true, tab: "runs", width: 480, previewSeen: true });
    expect(all.odd).toMatchObject({ open: false, tab: "changes", width: null, wide: false });
    expect(parseWorkbenches("{not json", NOW)).toEqual({});
    expect(parseWorkbenches(null, NOW)).toEqual({});
  });

  it("keeps a dragged width between the panel's minimum and the chat's", () => {
    expect(clampWorkbenchWidth(100, 1400)).toBe(320);
    expect(clampWorkbenchWidth(700.4, 1400)).toBe(700);
    expect(clampWorkbenchWidth(1200, 1400)).toBe(980);
  });
});
