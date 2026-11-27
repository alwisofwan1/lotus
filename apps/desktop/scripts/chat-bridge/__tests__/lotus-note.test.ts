import { describe, expect, it } from "vitest";

import { CONCISE_REPLIES_NOTE, LOTUS_DELEGATION_NOTE, SUB_AGENT_NOTE, VERIFIER_NOTE, agentNameNote, lotusNote, subAgentNote } from "../delegation-note";
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

describe("subAgentNote", () => {
  it("tells a delegated chat to do its task itself instead of how to delegate", () => {
    expect(lotusNote(false, subAgentNote("worker"))).toBe(SUB_AGENT_NOTE);
    expect(lotusNote(true, subAgentNote("verifier"))).toBe(`${VERIFIER_NOTE}\n\n${CONCISE_REPLIES_NOTE}`);
    expect(lotusNote(false, subAgentNote(undefined))).toBe(LOTUS_DELEGATION_NOTE);
    expect(SUB_AGENT_NOTE).toContain("Do not hand it on");
  });

  it("accepts only the two roles the host sends", () => {
    expect(threadStartParams.parse({ threadId: "t", cwd: "/r", subAgent: "verifier" }).subAgent).toBe("verifier");
    expect(threadStartParams.parse({ threadId: "t", cwd: "/r" }).subAgent).toBeUndefined();
    expect(() => threadStartParams.parse({ threadId: "t", cwd: "/r", subAgent: "lead" })).toThrow();
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
