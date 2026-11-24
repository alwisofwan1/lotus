import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  BUSY_POLL_MS,
  IDLE_POLL_MS,
  conversationPollDelayMs,
  fallbackPartText,
  isPageBusy,
  rawPartTypeOf,
  readConversationPage,
  type HostConversationPage,
} from "../host-conversation";

/** The payload `packages/host` and `apps/pocket` both test against — see `contract/README.md`. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), "../../contract/fixtures", name), "utf8"));
}

function page(over: Partial<HostConversationPage> = {}): HostConversationPage {
  return { paneId: "ss-1", runner: "claude", source: "ring", turns: [], hasMore: false, ...over };
}

describe("reading a headless cell's conversation", () => {
  /**
   * The rule ticket 12 is built on, and the one worth failing a build over. The list of part
   * kinds in that ticket was read off ONE short conversation on ONE runner and is stated there to
   * be incomplete — `conversation.ts` in the host already defines several more. A reader that
   * kept only the kinds it recognised would hand the canvas a conversation with steps missing and
   * nothing on screen saying so.
   */
  it("keeps a part whose type it has never seen, verbatim", () => {
    const read = readConversationPage({
      paneId: "ss-1", runner: "claude", source: "ring", hasMore: false,
      turns: [{
        turnId: "t1", startedAt: 1, parts: [
          { id: "a", ts: 1, seq: 0, type: "assistant_text", text: "hi", state: "done", truncated: false },
          { id: "b", ts: 2, seq: 1, type: "subagent_spawned", text: "delegating to reviewer", agentId: "sub-1" },
        ],
      }],
    });

    const parts = read!.turns[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[1].type).toBe("subagent_spawned");
    // And its own fields survive, because a future renderer for it will need them.
    expect(parts[1].raw.agentId).toBe("sub-1");
  });

  /**
   * A part that is not even an object still happened. Dropping it would be the same silence,
   * arrived at by a different route.
   */
  it("keeps a part it cannot read at all, rather than leaving a hole", () => {
    const read = readConversationPage({ turns: [{ turnId: "t1", startedAt: 1, parts: ["???", 7] }] });
    expect(read!.turns[0].parts).toHaveLength(2);
    expect(read!.turns[0].parts[0].type).toBe("");
  });

  /**
   * `seq` exists because `ts` is not enough — the host's own comment says timestamps collide
   * inside a millisecond. Ordering by arrival would put a tool call before the message that
   * announced it whenever two parts share a stamp.
   */
  it("orders parts by seq, not by the order they arrived in", () => {
    const read = readConversationPage({
      turns: [{ turnId: "t1", startedAt: 1, parts: [
        { id: "second", ts: 5, seq: 2, type: "assistant_text" },
        { id: "first", ts: 5, seq: 1, type: "user_message" },
      ] }],
    });
    expect(read!.turns[0].parts.map((p) => p.id)).toEqual(["first", "second"]);
  });

  /**
   * The node polls this on a timer. A host mid-restart answering an error page must leave the
   * last good conversation on screen, so "not a page" has to be distinguishable from "no turns".
   */
  it("answers null for something that is not a page, and a page for one with no turns", () => {
    expect(readConversationPage(null)).toBeNull();
    expect(readConversationPage("nope")).toBeNull();
    expect(readConversationPage({ ok: false, error: "no conversation" })).toBeNull();
    expect(readConversationPage({ turns: [] })?.turns).toEqual([]);
  });

  /** The real wire payload, so this reader goes red if the host changes the shape under it. */
  it("reads the contract fixture whole, part for part", () => {
    const read = readConversationPage(fixture("rest-conversation.json"))!;
    expect(read.paneId).toBe("p-1");
    expect(read.runner).toBe("claude");
    expect(read.turns).toHaveLength(1);
    expect(read.turns[0].parts.map((p) => p.type)).toEqual([
      "user_message", "tool_call", "tool_call", "assistant_text",
    ]);
    expect(read.turns[0].stopReason).toBe("end_turn");
  });

  it("reads the native fixture too — the shape a headless cell actually serves", () => {
    const read = readConversationPage(fixture("rest-conversation-native.json"))!;
    expect(read.runner).toBe("codex");
    expect(read.turns[0].parts.every((part) => part.raw.provenance === "native")).toBe(true);
  });
});

describe("what a part says when the canvas has no component for it", () => {
  /**
   * The host has its OWN `unknown` part, for an event it could not name, and the original kind is
   * in `rawType`. Printing the word "unknown" over that would hide the single fact worth
   * reporting about it.
   */
  it("prefers the host's rawType over the word 'unknown'", () => {
    const read = readConversationPage({
      turns: [{ turnId: "t", startedAt: 0, parts: [
        { id: "u", ts: 0, seq: 0, type: "unknown", rawType: "session/mcp_server_status", summary: "two servers up" },
      ] }],
    })!;
    expect(rawPartTypeOf(read.turns[0].parts[0])).toBe("session/mcp_server_status");
    expect(fallbackPartText(read.turns[0].parts[0])).toBe("two servers up");
  });

  /** A part with no prose at all still has to show something, or it is invisible again. */
  it("never falls back to nothing", () => {
    const read = readConversationPage({
      turns: [{ turnId: "t", startedAt: 0, parts: [{ id: "x", ts: 0, seq: 0, type: "weird", count: 3 }] }],
    })!;
    expect(fallbackPartText(read.turns[0].parts[0])).toContain("count");
    expect(rawPartTypeOf(read.turns[0].parts[0])).toBe("weird");
  });
});

describe("how often the canvas asks the host again", () => {
  const openTurn = { turnId: "t", startedAt: 1, parts: [] };
  const closedTurn = { ...openTurn, endedAt: 2, stopReason: "end_turn" };

  /** One poll is one ssh round trip. A node collapsed to a glyph is not being read. */
  it("does not ask at all for a node nobody is looking at", () => {
    expect(conversationPollDelayMs(page({ turns: [openTurn] }), false)).toBeNull();
  });

  it("asks quickly while the agent is mid-turn", () => {
    expect(conversationPollDelayMs(page({ turns: [closedTurn, openTurn] }), true)).toBe(BUSY_POLL_MS);
    expect(isPageBusy(page({ turns: [openTurn] }))).toBe(true);
  });

  /**
   * **A deliberate departure from the ticket, which says to stop once the last turn closes.**
   * This cell is also reachable from the phone — that is the entire reason the feature exists —
   * so a turn started over there would never appear, and the node would sit showing a
   * conversation that had quietly stopped being true. Slowing down keeps continuity; stopping
   * throws it away.
   */
  it("slows down but keeps asking once the turn has closed", () => {
    expect(conversationPollDelayMs(page({ turns: [closedTurn] }), true)).toBe(IDLE_POLL_MS);
    expect(IDLE_POLL_MS).toBeGreaterThan(BUSY_POLL_MS);
  });

  /** Before the first answer there is no page, and it must still poll or it never starts. */
  it("asks even before it has anything to show", () => {
    expect(conversationPollDelayMs(null, true)).toBe(IDLE_POLL_MS);
  });
});
