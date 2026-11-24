import { describe, it, expect } from "vitest";
import { formatPeerMessage, resolveAgentDisplayName } from "../canvas-peer-message";

describe("formatPeerMessage", () => {
  it("attributes the sender and nothing more", () => {
    expect(formatPeerMessage("the digest query still reads users.name", "nova"))
      .toBe("[from @nova]\nthe digest query still reads users.name");
  });

  it("does not repeat the reply instruction the dispatcher already sends", () => {
    // The sidecar's `replyTo` envelope already tells the receiver how to answer. Saying it again
    // here cost every peer message a duplicated paragraph.
    const formatted = formatPeerMessage("do the thing", "nova").toLowerCase();
    expect(formatted).not.toContain("lotus_dispatch_to_cell");
    expect(formatted).not.toContain("reply");
  });

  it("leaves a human dispatch untouched — no sender, no envelope", () => {
    expect(formatPeerMessage("run the tests", null)).toBe("run the tests");
    expect(formatPeerMessage("run the tests", undefined)).toBe("run the tests");
    expect(formatPeerMessage("run the tests", "   ")).toBe("run the tests");
  });

  it("keeps the body verbatim, including its own newlines", () => {
    const body = "line one\nline two\n  indented";
    expect(formatPeerMessage(body, "atlas").endsWith(body)).toBe(true);
  });

  it("puts the attribution on its own line so the body starts clean", () => {
    const [first, ...rest] = formatPeerMessage("do the thing", "atlas").split("\n");
    expect(first).toContain("@atlas");
    expect(rest.join("\n")).toBe("do the thing");
  });

  it("does not attribute an empty body", () => {
    expect(formatPeerMessage("   ", "atlas")).toBe("   ");
  });
});

describe("resolveAgentDisplayName", () => {
  const roster = [{ id: "n1", name: "Nova" }];
  const visible = [{ id: "n2", name: "Atlas" }];

  it("prefers the live roster name", () => {
    expect(resolveAgentDisplayName("n1", roster, visible)).toBe("Nova");
  });

  it("falls back to a visible node whose runtime entry has not published yet", () => {
    expect(resolveAgentDisplayName("n2", roster, visible)).toBe("Atlas");
  });

  it("falls back to the node id when nothing names it", () => {
    expect(resolveAgentDisplayName("n3", roster, visible)).toBe("n3");
  });

  it("returns null for no node at all", () => {
    expect(resolveAgentDisplayName(null, roster, visible)).toBeNull();
  });
});
