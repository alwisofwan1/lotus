import { describe, expect, it } from "vitest";

import type { ConversationUpdate } from "../../../../types/conversation.js";
import type { TranscriptEntry } from "../../../../types/transcript.js";
import { ConversationStream } from "../conversation-stream.js";

let stamp = 1_754_700_000_000;

function entry(over: Partial<TranscriptEntry>): TranscriptEntry {
  stamp += 1000;
  return {
    event: "stop",
    title: "",
    body: "",
    status: "",
    userPrompt: "",
    toolTarget: "",
    timestamp: stamp,
    ...over,
  } as TranscriptEntry;
}

function push(s: ConversationStream, pane: string, e: TranscriptEntry): string[] {
  return s.push(pane, e).map(describe_);
}

/**
 * Named exhaustively rather than as an `else`, because this lane converts whole entries and
 * therefore **cannot** produce a `text` delta — an entry arrives with its text already whole.
 * A `text` here would be the converter inventing streaming it never saw.
 */
function describe_(u: ConversationUpdate): string {
  switch (u.kind) {
    case "turn":
      return `turn ${u.turn.turnId}${u.turn.endedAt === undefined ? "" : " closed"}`;
    case "part":
      return `${u.part.type} ${u.part.id}`;
    case "text":
      return `text ${u.partId} (unexpected on the hook lane)`;
  }
}

describe("ConversationStream", () => {
  it("opens a turn and carries the prompt as its first part", () => {
    // The prompt text is the entry's `body`; `userPrompt` is the shorter, differently
    // clipped copy the converter uses only to spot a turn boundary.
    const s = new ConversationStream();
    const out = push(s, "p-1", entry({ event: "prompt-submit", body: "run the tests" }));
    expect(out[0]).toMatch(/^turn /);
    expect(out.filter((l) => l.startsWith("user_message"))).toHaveLength(1);
  });

  it("emits nothing for an entry that converts to nothing", () => {
    const s = new ConversationStream();
    push(s, "p-1", entry({ event: "prompt-submit", body: "go" }));
    const first = push(s, "p-1", entry({ event: "tool-pre", title: "Read", toolTarget: "a.ts" }));
    expect(first.some((l) => l.startsWith("tool_call"))).toBe(true);
    // A hook event this host has no part for changes the conversion not at all, so nothing
    // reaches the wire — the whole point of diffing rather than resending the page.
    expect(s.push("p-1", entry({ event: "prompt-submit", body: "" }))).toEqual([
      { kind: "turn", turn: expect.objectContaining({ turnId: expect.any(String) }) },
    ]);
  });

  it("revises a tool call in place when its result arrives, rather than adding a second one", () => {
    const s = new ConversationStream();
    push(s, "p-1", entry({ event: "prompt-submit", body: "go" }));
    const pre = push(s, "p-1", entry({ event: "tool-pre", title: "Edit", toolTarget: "a.ts" }));
    const post = push(s, "p-1", entry({ event: "tool-post", title: "Edit", toolTarget: "a.ts" }));
    const preId = pre.find((l) => l.startsWith("tool_call"));
    const postId = post.find((l) => l.startsWith("tool_call"));
    expect(preId).toBeDefined();
    // Same id, sent again — a revision. This is the pairing the phone used to do itself.
    expect(postId).toBe(preId);
  });

  it("does not renumber the world when an entry lands, so old parts stay quiet", () => {
    const s = new ConversationStream();
    push(s, "p-1", entry({ event: "prompt-submit", body: "go" }));
    push(s, "p-1", entry({ event: "tool-pre", title: "Read", toolTarget: "a.ts" }));
    push(s, "p-1", entry({ event: "tool-post", title: "Read", toolTarget: "a.ts" }));
    const later = push(s, "p-1", entry({ event: "tool-pre", title: "Bash", toolTarget: "ls" }));
    // Only the new call, never the settled one before it: `seq` moves for every part on
    // every conversion, and keying on it would repaint the whole page per step.
    expect(later.filter((l) => l.startsWith("tool_call"))).toHaveLength(1);
  });

  it("keeps panes apart", () => {
    const s = new ConversationStream();
    push(s, "p-1", entry({ event: "prompt-submit", body: "one" }));
    const other = push(s, "p-2", entry({ event: "prompt-submit", body: "two" }));
    expect(other.some((l) => l.startsWith("turn"))).toBe(true);
    expect(s.size()).toBe(2);
  });

  it("forgets a closed cell entirely", () => {
    const s = new ConversationStream();
    push(s, "p-1", entry({ event: "prompt-submit", body: "go" }));
    s.forget("p-1");
    expect(s.size()).toBe(0);
    // A cell that comes back is a fresh conversation, not a continuation of a dropped cursor.
    expect(push(s, "p-1", entry({ event: "prompt-submit", body: "again" })).length).toBeGreaterThan(0);
  });

  it("holds a bounded number of entries per pane", () => {
    const s = new ConversationStream(3);
    for (let i = 0; i < 10; i++) push(s, "p-1", entry({ event: "tool-pre", title: `T${i}`, toolTarget: "x" }));
    // The cap is on what is held for conversion; the phone keeps its own page.
    expect(s.size()).toBe(1);
  });
});
