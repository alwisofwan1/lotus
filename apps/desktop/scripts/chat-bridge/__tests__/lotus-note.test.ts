import { describe, expect, it } from "vitest";

import { CONCISE_REPLIES_NOTE, LOTUS_DELEGATION_NOTE, agentNameNote, lotusNote } from "../delegation-note";
import { threadStartParams } from "../protocol";

describe("lotusNote", () => {
  it("adds the reply style only when Concise replies is on", () => {
    expect(lotusNote(false)).toBe(LOTUS_DELEGATION_NOTE);
    expect(lotusNote(undefined, "base")).toBe("base");
    expect(lotusNote(true, "base")).toBe(`base\n\n${CONCISE_REPLIES_NOTE}`);
  });

  it("starts a thread with it off when the host does not say", () => {
    expect(threadStartParams.parse({ threadId: "t", cwd: "/repo" }).conciseReplies).toBe(false);
  });
});

describe("agentNameNote", () => {
  it("tells a session its name once, and again only after a rename", () => {
    expect(agentNameNote(undefined, "Nara")).toBe("Your name in Lotus is Nara. The user may call you by it.");
    expect(agentNameNote("Nara", "Nara")).toBeNull();
    expect(agentNameNote("Nara", "Kirana")).toBe("Your name is now Kirana; you were Nara.");
    expect(agentNameNote(undefined, null)).toBeNull();
  });
});
