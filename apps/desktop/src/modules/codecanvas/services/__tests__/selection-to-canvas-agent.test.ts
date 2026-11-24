import { describe, expect, it, vi } from "vitest";
import { routeSelectionToCanvasAgent } from "../selection-to-canvas-agent";

describe("routeSelectionToCanvasAgent", () => {
  it("types the text into the first preferred agent that can take it, without submitting", () => {
    const inserted: Array<[string, string]> = [];
    const result = routeSelectionToCanvasAgent({
      text: "src/a.ts:1-2",
      candidates: ["term-focus", "term-other"],
      insertInto: (id, text) => {
        inserted.push([id, text]);
        return true;
      },
    });
    expect(result).toEqual({ ok: true, nodeId: "term-focus" });
    expect(inserted).toEqual([["term-focus", "src/a.ts:1-2"]]);
  });

  it("skips an agent that cannot take text and falls through to the next", () => {
    const insertInto = vi.fn((id: string) => id === "term-2");
    const result = routeSelectionToCanvasAgent({ text: "x", candidates: ["term-1", "term-2"], insertInto });
    expect(result).toEqual({ ok: true, nodeId: "term-2" });
    expect(insertInto).toHaveBeenCalledTimes(2);
  });

  it("says plainly when there is no agent to send to", () => {
    const result = routeSelectionToCanvasAgent({ text: "x", candidates: [], insertInto: () => true });
    expect(result).toEqual({ ok: false, reason: "There is no agent on this board that can take the selection." });
  });
});
