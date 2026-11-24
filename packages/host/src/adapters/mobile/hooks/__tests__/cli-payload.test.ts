import { describe, expect, it } from "vitest";

import { parseCliHookPayload } from "../cli-payload.js";

/**
 * Slice 3.1. The shapes here are the ones `scripts/agent-notify/payload-extractors.mjs` reads —
 * that file's comments say they were measured off live runs rather than taken from docs, and it
 * is the only producer in this repo that has ever been fed by a real CLI.
 *
 * Everything about this parser is fail-soft. It sits behind an endpoint a **hook** calls, and a
 * hook that sees an error is a hook whose author blocks the tool call.
 */
describe("parseCliHookPayload", () => {
  it("reads the transcript path Claude sends on every event", () => {
    const body = JSON.stringify({
      session_id: "1f0b0d2e-aaaa-bbbb-cccc-000000000001",
      transcript_path: "/home/alwi/.claude/projects/-home-alwi-proj/1f0b0d2e.jsonl",
      cwd: "/home/alwi/proj",
      hook_event_name: "Notification",
    });

    expect(parseCliHookPayload(body)).toEqual({
      sessionId: "1f0b0d2e-aaaa-bbbb-cccc-000000000001",
      transcriptPath: "/home/alwi/.claude/projects/-home-alwi-proj/1f0b0d2e.jsonl",
      cwd: "/home/alwi/proj",
    });
  });

  /** The producer accepts three spellings of the session id; so does this. */
  it("accepts the other spellings of the session id", () => {
    const withPath = (extra: object) =>
      parseCliHookPayload(JSON.stringify({ transcript_path: "/t.jsonl", ...extra }));

    expect(withPath({ sessionId: "s-1" })?.sessionId).toBe("s-1");
    expect(withPath({ session: { id: "s-2" } })?.sessionId).toBe("s-2");
  });

  it("accepts the camelCase transcript path", () => {
    expect(parseCliHookPayload(JSON.stringify({ transcriptPath: "/t.jsonl" }))?.transcriptPath)
      .toBe("/t.jsonl");
  });

  describe("failing soft, because the caller is a hook", () => {
    it("says nothing for a body it cannot parse", () => {
      expect(parseCliHookPayload("{not json")).toBeUndefined();
      expect(parseCliHookPayload("")).toBeUndefined();
      expect(parseCliHookPayload("[]")).toBeUndefined();
      expect(parseCliHookPayload("null")).toBeUndefined();
    });

    /**
     * A payload with no path at all is not an error — `SessionStart` carries one, a stray
     * caller may not. It simply has nothing to record.
     */
    it("says nothing when there is no transcript path", () => {
      expect(parseCliHookPayload(JSON.stringify({ session_id: "s" }))).toBeUndefined();
    });

    it("ignores a path that is not a string", () => {
      expect(parseCliHookPayload(JSON.stringify({ transcript_path: 12 }))).toBeUndefined();
    });

    /** The cap is the schema's, re-applied because this body arrives straight off a pipe. */
    it("refuses an absurd path rather than storing it", () => {
      const long = "/".padEnd(5000, "x");
      expect(parseCliHookPayload(JSON.stringify({ transcript_path: long }))).toBeUndefined();
    });

    it("drops a session id or cwd it cannot use, keeping the path", () => {
      const parsed = parseCliHookPayload(
        JSON.stringify({ transcript_path: "/t.jsonl", session_id: 7, cwd: null }),
      );
      expect(parsed).toEqual({ transcriptPath: "/t.jsonl" });
    });
  });
});
