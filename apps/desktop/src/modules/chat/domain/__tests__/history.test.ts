import { describe, expect, it } from "vitest";

import { MAX_TICKS, MIN_PROMPTS, activeTick, buildPromptIndex, railFit, railTicks, snippet } from "../history";
import type { TimelineRow } from "../timeline";

const user = (id: string, text: string): TimelineRow => ({ kind: "user", id, turnId: id, text, clientRequestId: id, attachments: [] });
const reply = (turnId: string, text: string): TimelineRow => ({ kind: "assistant", id: `a-${turnId}-${text}`, turnId, text, streaming: false });

describe("history rail", () => {
  it("indexes each prompt with the start of its first reply", () => {
    const rows = [user("u1", "Fix the **build**"), reply("u1", "Done.\n\nIt was `tsc`."), reply("u1", "later"), user("u2", "and now?")];
    expect(buildPromptIndex(rows)).toEqual([
      { rowIndex: 0, prompt: "Fix the build", reply: "Done. It was tsc." },
      { rowIndex: 3, prompt: "and now?", reply: "" },
    ]);
  });

  it("cuts long text and drops code blocks", () => {
    expect(snippet("see ```ts\nconst x = 1\n``` ok")).toBe("see ok");
    expect(snippet("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
  });

  it("groups prompts into ranges past the cap, covering every prompt once", () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({ rowIndex: i * 2, prompt: `p${i}`, reply: "" }));
    const ticks = railTicks(entries, 3);
    expect(ticks.map((t) => [t.from, t.to])).toEqual([[1, 2], [3, 4], [5, 7]]);
    expect(railTicks(entries).length).toBe(7);
    expect(activeTick(ticks, 0)).toBe(0);
    expect(activeTick(ticks, 5)).toBe(1);
    expect(activeTick(ticks, 99)).toBe(2);
  });

  it("fits as many marks as the timeline's height allows, never fewer than the rail's minimum", () => {
    expect(railFit(0)).toBe(MAX_TICKS);
    expect(railFit(696)).toBe(100);
    expect(railFit(100)).toBe(MIN_PROMPTS);
  });
});
