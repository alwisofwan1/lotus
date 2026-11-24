import { describe, expect, it } from "vitest";

import type { ConversationUpdate } from "../../../../types/conversation.js";
import { ConversationDeltaLog } from "../delta-log.js";

function turn(id: string): ConversationUpdate {
  return { kind: "turn", turn: { turnId: id, startedAt: 1 } };
}

describe("ConversationDeltaLog", () => {
  it("stamps a monotonic cursor per cell, starting at 1", () => {
    const log = new ConversationDeltaLog();
    expect(log.append("p-1", "claude", turn("t-0"))).toBe(1);
    expect(log.append("p-1", "claude", turn("t-1"))).toBe(2);
    // Per cell, not global: two cells each start their own count, and a client resuming one
    // must not have its cursor moved by traffic on the other.
    expect(log.append("p-2", "codex", turn("t-0"))).toBe(1);
  });

  it("replays everything after a cursor", () => {
    const log = new ConversationDeltaLog();
    for (const id of ["a", "b", "c"]) log.append("p-1", "claude", turn(id));
    const answer = log.since("p-1", 1);
    expect(answer.truncated).toBe(false);
    expect(answer.deltas.map((d) => d.cursor)).toEqual([2, 3]);
  });

  it("gives a client with nothing everything it holds", () => {
    const log = new ConversationDeltaLog();
    log.append("p-1", "claude", turn("a"));
    expect(log.since("p-1", 0).deltas.map((d) => d.cursor)).toEqual([1]);
    expect(log.since("p-1", 0).truncated).toBe(false);
  });

  it("says nothing new when the client is current", () => {
    const log = new ConversationDeltaLog();
    log.append("p-1", "claude", turn("a"));
    expect(log.since("p-1", 1)).toMatchObject({ deltas: [], truncated: false });
  });

  it("refuses a cursor that fell off the front, rather than leaving a hole", () => {
    // The failure this whole file exists to prevent: handing back the oldest held deltas
    // would look like success and drop the middle of the transcript.
    const log = new ConversationDeltaLog(3);
    for (const id of ["a", "b", "c", "d", "e"]) log.append("p-1", "claude", turn(id));
    const answer = log.since("p-1", 1);
    expect(answer.truncated).toBe(true);
    expect(answer.deltas).toEqual([]);
    expect(answer.oldestCursor).toBe(3);
  });

  it("serves the boundary cursor, which is the common reconnect", () => {
    // A client holding exactly the oldest-but-one is still whole: it needs `oldestCursor`
    // onwards, and that is held. Off by one here is a spurious full refetch every reconnect.
    const log = new ConversationDeltaLog(3);
    for (const id of ["a", "b", "c", "d"]) log.append("p-1", "claude", turn(id));
    const answer = log.since("p-1", 1);
    expect(answer.truncated).toBe(false);
    expect(answer.deltas.map((d) => d.cursor)).toEqual([2, 3, 4]);
  });

  it("answers empty for a cell it has never seen", () => {
    const log = new ConversationDeltaLog();
    expect(log.since("p-nope", 7)).toEqual({ deltas: [], truncated: false, oldestCursor: 0 });
  });

  it("holds only the tail, bounded per cell", () => {
    const log = new ConversationDeltaLog(2);
    for (const id of ["a", "b", "c"]) log.append("p-1", "claude", turn(id));
    expect(log.since("p-1", 0).deltas.map((d) => d.cursor)).toEqual([2, 3]);
  });

  it("drops a cell that left the fleet, cursor and all", () => {
    const log = new ConversationDeltaLog();
    log.append("p-1", "claude", turn("a"));
    log.append("p-2", "claude", turn("a"));
    log.retain(new Set(["p-2"]));
    expect(log.size()).toBe(1);
    // A pane id is never reused, so the count starts fresh rather than leaking.
    expect(log.append("p-1", "claude", turn("a"))).toBe(1);
  });

  it("carries the runner along, because a Part does not name one", () => {
    const log = new ConversationDeltaLog();
    log.append("p-1", "cursor", turn("a"));
    expect(log.since("p-1", 0).deltas[0]?.agentType).toBe("cursor");
  });
});
