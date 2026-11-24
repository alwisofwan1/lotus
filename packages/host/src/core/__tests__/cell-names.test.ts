import { describe, expect, it } from "vitest";

import { CELL_NAME_POOL, nextCellName } from "../cell-names.js";

describe("nextCellName", () => {
  it("hands out the pool in order, so a fleet reads the same way every time", () => {
    expect(nextCellName([])).toBe(CELL_NAME_POOL[0]);
    expect(nextCellName([CELL_NAME_POOL[0] as string])).toBe(CELL_NAME_POOL[1]);
  });

  it("skips a name already in use, however it was spelled", () => {
    expect(nextCellName([" atlas "])).toBe(CELL_NAME_POOL[1]);
    expect(nextCellName(["ATLAS", "nova"])).toBe(CELL_NAME_POOL[2]);
  });

  /** A name is what a person reads; two cells sharing one is the whole bug this closes. */
  it("never repeats a name, even past the end of the pool", () => {
    const taken = [...CELL_NAME_POOL];
    expect(nextCellName(taken)).toBe("Agent 1");
    expect(nextCellName([...taken, "Agent 1"])).toBe("Agent 2");
    // Gaps are filled rather than skipped past — the numbering is "smallest free", not a counter.
    expect(nextCellName([...taken, "Agent 2"])).toBe("Agent 1");
  });

  it("ignores names nobody could confuse, including whatever a client already chose", () => {
    expect(nextCellName(["Rowan", "Kestrel"])).toBe(CELL_NAME_POOL[0]);
  });
});
