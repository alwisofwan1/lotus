import { describe, expect, it } from "vitest";
import { StreamHub } from "../stream-hub.js";

const turn = { kind: "turn", turn: { turnId: "t-1", startedAt: 1 } } as const;

function hub(): StreamHub {
  return new StreamHub({ host: { hostId: "vps", hostLabel: "VPS", mode: "standalone" } });
}

describe("StreamHub conversation listeners", () => {
  it("hands each logged delta and its cursor to a listener until it unsubscribes", () => {
    const h = hub();
    const seen: Array<[string, number]> = [];
    const off = h.onConversation((paneId, _agent, _update, cursor) => seen.push([paneId, cursor]));
    h.publishConversation("p-1", "claude", turn);
    h.publishConversation("p-1", "claude", turn);
    off();
    h.publishConversation("p-1", "claude", turn);
    expect(seen).toEqual([["p-1", 1], ["p-1", 2]]);
  });

  it("keeps publishing when one listener throws", () => {
    const h = hub();
    const seen: number[] = [];
    h.onConversation(() => { throw new Error("broken transport"); });
    h.onConversation((_p, _a, _u, cursor) => seen.push(cursor));
    h.publishConversation("p-1", "claude", turn);
    expect(seen).toEqual([1]);
  });

  it("answers conversationSince from the same log the phone resumes from", () => {
    const h = hub();
    h.publishConversation("p-1", "claude", turn);
    h.publishConversation("p-1", "claude", turn);
    expect(h.conversationSince("p-1", 1).deltas.map((d) => d.cursor)).toEqual([2]);
  });
});
