import { describe, expect, it } from "vitest";

import type { Turn } from "../../../../types/conversation.js";
import { CUT_OFF_MESSAGE, closeCutTurn, endedTurn, genTurns, genUpdate, savedTurns } from "../saved-turns.js";

const turn = (turnId: string, endedAt?: number): Turn => ({
  turnId,
  startedAt: 1,
  ...(endedAt === undefined ? {} : { endedAt, stopReason: "end_turn" as const }),
  parts: [{ type: "user_message", text: "hi", id: `${turnId}-prompt`, ts: 1, seq: 0, provenance: "native" }],
});

describe("savedTurns", () => {
  it("keeps earlier turns and renames live ones so a resumed runner's t-0 cannot collide", () => {
    const out = savedTurns([turn("old")], genTurns([turn("t-0", 2)], "g1"));
    expect(out.map((t) => t.turnId)).toEqual(["old", "g1:t-0"]);
    expect(out[1]?.parts[0]?.id).toBe("g1:t-0-prompt");
  });

  it("names a live update the way the saved turn is named, so a restart does not rename a drawn turn", () => {
    const part = turn("t-0").parts[0]!;
    expect(genUpdate({ kind: "turn", turn: { turnId: "t-0", startedAt: 1 } }, "g1")).toMatchObject({ turn: { turnId: "g1:t-0" } });
    expect(genUpdate({ kind: "part", turnId: "t-0", part }, "g1")).toMatchObject({ turnId: "g1:t-0", part: { id: "g1:t-0-prompt" } });
    expect(genUpdate({ kind: "text", turnId: "t-0", partId: "a", delta: "x", seq: 1 }, "g1")).toMatchObject({ turnId: "g1:t-0", partId: "g1:a" });
  });

  it("keeps only the newest turns past the cap", () => {
    const many = Array.from({ length: 205 }, (_, i) => turn(`p${i}`, 2));
    const out = savedTurns(many, []);
    expect(out).toHaveLength(200);
    expect(out[0]?.turnId).toBe("p5");
  });
});

describe("closeCutTurn", () => {
  it("closes a turn left open by the restart and says so, without resending it", () => {
    const out = closeCutTurn([turn("a", 2), turn("b")], 9);
    const last = out.at(-1);
    expect(last?.endedAt).toBe(9);
    expect(last?.stopReason).toBe("cancelled");
    expect(last?.parts.at(-1)).toMatchObject({ type: "error", message: CUT_OFF_MESSAGE, recoverable: true });
  });

  it("leaves a finished conversation alone", () => {
    const turns = [turn("a", 2)];
    expect(closeCutTurn(turns, 9)).toEqual(turns);
  });
});

describe("endedTurn", () => {
  it("is a closed turn carrying the reason", () => {
    const t = endedTurn("thread gone", 5);
    expect(t.endedAt).toBe(5);
    expect(t.parts[0]).toMatchObject({ type: "error", recoverable: false });
    expect(t.parts[0]?.type === "error" && t.parts[0].message).toContain("thread gone");
  });
});
