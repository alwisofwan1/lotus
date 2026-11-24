import { describe, expect, it } from "vitest";

import { parseDropPayload, PAYLOAD_VERSION } from "../payload.js";

/**
 * Ported alongside `payload.rs`, against the frozen contract in
 * `plans/agent-hooks/drop-file-schema.md`. The producer is trusted for shape and NOT for size:
 * this side is what stands between a misbehaving hook script and a phone.
 */

const valid = (over: Record<string, unknown> = {}): string => JSON.stringify({
  version: 1,
  sessionId: "abc-123",
  agentType: "claude",
  event: "needs-input",
  status: "needs-input",
  title: "Needs input",
  body: "Do you want to create approved.txt?",
  userPrompt: "make the file",
  cwd: "/srv/api",
  pid: 12345,
  agentPid: 12340,
  paneId: "pane-7",
  timestamp: 1714000000000,
  ...over,
});

const ok = (raw: string) => {
  const result = parseDropPayload(raw);
  if (!result.ok) throw new Error(`expected a payload, got ${JSON.stringify(result.error)}`);
  return result.payload;
};

describe("parseDropPayload", () => {
  it("reads a v1 drop the hook script writes", () => {
    const payload = ok(valid());

    expect(payload).toMatchObject({
      version: PAYLOAD_VERSION,
      sessionId: "abc-123",
      agentType: "claude",
      event: "needs-input",
      status: "needs-input",
      cwd: "/srv/api",
      paneId: "pane-7",
    });
  });

  /**
   * `cwd` is the schema's correlation key and on a desktop that holds. Here several cells share
   * one project directory routinely, so `paneId` is the only unambiguous one — and a drop from an
   * external CLI has none, which must read as "unknown", not as somebody else's cell.
   */
  it("keeps the pane id, and says null rather than guessing when there is none", () => {
    expect(ok(valid()).paneId).toBe("pane-7");
    expect(ok(valid({ paneId: undefined })).paneId).toBeNull();
    expect(ok(valid({ paneId: "" })).paneId).toBeNull();
  });

  describe("refusing", () => {
    it("refuses a version it does not understand, rather than reading it anyway", () => {
      const result = parseDropPayload(valid({ version: 2 }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("unsupported-version");
    });

    it("refuses malformed JSON", () => {
      const result = parseDropPayload("{not json");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("json");
    });

    it("refuses a JSON document that is not an object", () => {
      expect(parseDropPayload("[1,2,3]").ok).toBe(false);
      expect(parseDropPayload('"a string"').ok).toBe(false);
    });

    for (const field of ["agentType", "event", "status"]) {
      it(`refuses a drop with no ${field}`, () => {
        const missing = parseDropPayload(valid({ [field]: undefined }));
        const blank = parseDropPayload(valid({ [field]: "   " }));
        expect(missing.ok).toBe(false);
        expect(blank.ok).toBe(false);
        if (!missing.ok) expect(missing.error).toEqual({ kind: "missing-field", field });
      });
    }
  });

  describe("clamping, which is the half the producer cannot be trusted with", () => {
    it("cuts a body past the cap and says that it did", () => {
      const payload = ok(valid({ body: "x".repeat(8001) }));

      expect(payload.body).toHaveLength(8000);
      expect(payload.bodyTruncated).toBe(true);
    });

    /**
     * The producer clamps first and reports it. A second pass that finds nothing left to cut
     * must not erase that — which is why the flag is ORed and truncation stays a boolean rather
     * than an appended ellipsis.
     */
    it("keeps a truncation the producer already reported", () => {
      expect(ok(valid({ body: "short", bodyTruncated: true })).bodyTruncated).toBe(true);
    });

    it("says nothing was cut when nothing was", () => {
      expect(ok(valid({ body: "short" })).bodyTruncated).toBe(false);
    });

    /** Idempotent: clamping an already-clamped payload changes nothing. */
    it("is idempotent, which is what makes clamping twice safe", () => {
      const once = ok(valid({ body: "x".repeat(9000) }));
      const twice = ok(JSON.stringify({ ...once, version: 1 }));

      expect(twice.body).toBe(once.body);
      expect(twice.bodyTruncated).toBe(true);
    });

    it("clamps the other fields without claiming they were cut", () => {
      const payload = ok(valid({
        title: "t".repeat(300),
        userPrompt: "u".repeat(5000),
        cwd: "/".repeat(5000),
        sessionId: "s".repeat(400),
      }));

      expect(payload.title).toHaveLength(200);
      expect(payload.userPrompt).toHaveLength(4000);
      expect(payload.cwd).toHaveLength(4096);
      expect(payload.sessionId).toHaveLength(256);
      expect(payload.bodyTruncated).toBe(false);
    });

    /** A cut that splits a surrogate pair produces a lone code unit — half a character. */
    it("never cuts a character in half", () => {
      const payload = ok(valid({ body: "a".repeat(7999) + "\u{1f600}" }));

      expect(payload.body.endsWith("\u{1f600}")).toBe(false);
      expect([...payload.body].every((c) => c.codePointAt(0)! < 0xd800 || c.codePointAt(0)! > 0xdfff))
        .toBe(true);
    });
  });

  describe("additive fields, which is why the version stays 1", () => {
    it("defaults the fields an older producer does not send", () => {
      const payload = ok(valid({
        toolTarget: undefined,
        transcriptPath: undefined,
        bodyTruncated: undefined,
      }));

      expect(payload.toolTarget).toBe("");
      expect(payload.transcriptPath).toBe("");
      expect(payload.bodyTruncated).toBe(false);
    });

    /**
     * `undefined` rather than 0: "changed nothing" and "no diff applies here" are different
     * claims, and a Read step must not render "+0 −0".
     */
    it("leaves line counts absent when the tool changed no lines to count", () => {
      const payload = ok(valid());

      expect(payload).not.toHaveProperty("linesAdded");
      expect(ok(valid({ linesAdded: 0 })).linesAdded).toBe(0);
    });

    it("ignores a field it has never heard of", () => {
      expect(ok(valid({ somethingNew: { nested: true } })).agentType).toBe("claude");
    });
  });
});
