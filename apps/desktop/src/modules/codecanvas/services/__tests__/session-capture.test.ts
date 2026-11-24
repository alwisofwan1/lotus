import { describe, expect, it } from "vitest";
import { capturesFromClaudeTranscripts, pickCapturableSessionId } from "../session-capture";

const set = (...ids: string[]) => new Set(ids);

describe("pickCapturableSessionId", () => {
  it("returns nothing while no transcript is new", () => {
    expect(pickCapturableSessionId(["a", "b"], set("a", "b"))).toBeNull();
    expect(pickCapturableSessionId([], set())).toBeNull();
  });

  it("picks the id that appeared after the baseline", () => {
    expect(pickCapturableSessionId(["fresh", "a", "b"], set("a", "b"))).toBe("fresh");
  });

  // The whole point of Slice 07: a pane told "that one is someone else's" must move on rather than
  // stop on a conversation it does not own.
  it("skips an id another node already claimed and offers the next one", () => {
    const ids = ["theirs", "mine", "old"];
    const baseline = set("old");
    expect(pickCapturableSessionId(ids, baseline)).toBe("theirs");
    expect(pickCapturableSessionId(ids, baseline, set("theirs"))).toBe("mine");
  });

  it("returns nothing when every new id is claimed, so the pane keeps polling", () => {
    expect(pickCapturableSessionId(["theirs", "old"], set("old"), set("theirs"))).toBeNull();
  });

  it("keeps the existing newest-first scan order", () => {
    // list_claude_sessions returns newest first; the previous implementation took the first match
    // and this must not change silently — the order is not evidence of ownership either way.
    expect(pickCapturableSessionId(["newest", "older"], set())).toBe("newest");
  });

  it("treats a rejected id as unavailable even when it is not in the baseline", () => {
    expect(pickCapturableSessionId(["only"], set(), set("only"))).toBeNull();
  });
});

describe("capturesFromClaudeTranscripts", () => {
  it("lets Claude-family runners capture from Claude's transcript dir", () => {
    expect(capturesFromClaudeTranscripts("claude")).toBe(true);
    expect(capturesFromClaudeTranscripts("custom", true)).toBe(true);
  });

  it("keeps Codex, Cursor and other custom runners out — they would claim another pane's Claude session", () => {
    expect(capturesFromClaudeTranscripts("codex")).toBe(false);
    expect(capturesFromClaudeTranscripts("cursor")).toBe(false);
    expect(capturesFromClaudeTranscripts("custom", false)).toBe(false);
  });
});
