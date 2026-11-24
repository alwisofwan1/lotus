import { describe, expect, it } from "vitest";

import type { ConversationUpdate, Part } from "../../../../types/conversation.js";
import { CONVERSATION_GRAMMAR_RULES, ConversationGrammar } from "../grammar.js";

const turn = (turnId: string, endedAt?: number): ConversationUpdate => ({
  kind: "turn",
  turn: { turnId, startedAt: 1000, ...(endedAt === undefined ? {} : { endedAt }) },
});

const part = (turnId: string, over: Partial<Part> & { id: string }): ConversationUpdate => ({
  kind: "part",
  turnId,
  part: {
    ts: 1000,
    seq: 0,
    provenance: "native",
    type: "assistant_text",
    text: "…",
    state: "streaming",
    truncated: false,
    ...over,
  } as Part,
});

const text = (turnId: string, partId: string, delta = "lo"): ConversationUpdate => ({
  kind: "text",
  turnId,
  partId,
  delta,
  seq: 1,
});

describe("ConversationGrammar", () => {
  it("accepts the shape every producer is meant to emit", () => {
    const g = new ConversationGrammar();
    expect(g.observe("p", turn("t-1"))).toBeUndefined();
    expect(g.observe("p", part("t-1", { id: "a", type: "user_message", text: "go" }))).toBeUndefined();
    expect(g.observe("p", part("t-1", { id: "b", text: "Hel" }))).toBeUndefined();
    expect(g.observe("p", part("t-1", { id: "b", text: "Hello", state: "done" }))).toBeUndefined();
    expect(g.observe("p", turn("t-1", 2000))).toBeUndefined();
  });

  /**
   * The rule bb gets for free and Lotus has to state: bb keys its timeline by `itemId` with the
   * turn as metadata, so an item cannot be in two turns. Lotus nests parts inside turns, and on
   * 2026-09-08 a phone drew one exchange twice because the same two parts arrived under a second
   * turn id. This is that bug, as a rule.
   */
  it("refuses a part that moves to another turn", () => {
    const g = new ConversationGrammar();
    g.observe("p", turn("t-1"));
    g.observe("p", part("t-1", { id: "a", state: "done" }));
    g.observe("p", turn("t-2"));

    expect(g.observe("p", part("t-2", { id: "a", state: "done" }))).toMatchObject({
      rule: CONVERSATION_GRAMMAR_RULES.partOneTurn,
    });
  });

  it("refuses a part for a turn nobody opened", () => {
    const g = new ConversationGrammar();
    expect(g.observe("p", part("t-9", { id: "a" }))).toMatchObject({
      rule: CONVERSATION_GRAMMAR_RULES.turnKnown,
    });
  });

  it("refuses a turn that ends twice", () => {
    const g = new ConversationGrammar();
    g.observe("p", turn("t-1"));
    expect(g.observe("p", turn("t-1", 2000))).toBeUndefined();
    expect(g.observe("p", turn("t-1", 2500))).toMatchObject({
      rule: CONVERSATION_GRAMMAR_RULES.turnSettlesOnce,
    });
  });

  it("refuses a turn that reopens after it ended", () => {
    const g = new ConversationGrammar();
    g.observe("p", turn("t-1"));
    g.observe("p", turn("t-1", 2000));
    expect(g.observe("p", turn("t-1"))).toMatchObject({
      rule: CONVERSATION_GRAMMAR_RULES.turnStartsOnce,
    });
  });

  it("allows a header to be re-sent while its turn is open", () => {
    // A title arriving late, a plan attached: the same turn described again is not a restart.
    const g = new ConversationGrammar();
    g.observe("p", turn("t-1"));
    expect(g.observe("p", turn("t-1"))).toBeUndefined();
  });

  it("refuses prose that goes back to streaming after it was done", () => {
    const g = new ConversationGrammar();
    g.observe("p", turn("t-1"));
    g.observe("p", part("t-1", { id: "a", text: "Hello", state: "done" }));
    expect(g.observe("p", part("t-1", { id: "a", text: "Hell", state: "streaming" }))).toMatchObject({
      rule: CONVERSATION_GRAMMAR_RULES.partSettlesOnce,
    });
  });

  it("refuses a completed tool call that goes back to running", () => {
    const g = new ConversationGrammar();
    g.observe("p", turn("t-1"));
    const call = (status: string): ConversationUpdate =>
      part("t-1", {
        id: "c", type: "tool_call", toolCallId: "c", toolName: "Read", title: "a.ts",
        kind: "read", status, locations: [],
      } as unknown as Partial<Part> & { id: string });
    g.observe("p", call("completed"));
    expect(g.observe("p", call("in_progress"))).toMatchObject({
      rule: CONVERSATION_GRAMMAR_RULES.partSettlesOnce,
    });
  });

  it("lets a growing reasoning part be re-sent, because it has no settled state to lose", () => {
    const g = new ConversationGrammar();
    g.observe("p", turn("t-1"));
    const think = (text: string): ConversationUpdate =>
      part("t-1", { id: "r", type: "reasoning", text, redacted: false } as unknown as Partial<Part> & { id: string });
    expect(g.observe("p", think("we"))).toBeUndefined();
    expect(g.observe("p", think("we should"))).toBeUndefined();
  });

  /**
   * The `text` kind carries no `Part`, so a client applies it to whatever it already holds
   * under that id. That is only safe because of these four checks — this is the block that
   * pays for the optimisation.
   */
  describe("a text delta", () => {
    it("is legal only after a part update opened the part", () => {
      const g = new ConversationGrammar();
      g.observe("p", turn("t-1"));
      expect(g.observe("p", text("t-1", "b"))).toMatchObject({
        rule: CONVERSATION_GRAMMAR_RULES.partOpensBeforeDelta,
      });
      expect(g.observe("p", part("t-1", { id: "b", text: "Hel" }))).toBeUndefined();
      expect(g.observe("p", text("t-1", "b"))).toBeUndefined();
    });

    it("cannot arrive for a turn nobody opened", () => {
      const g = new ConversationGrammar();
      expect(g.observe("p", text("t-9", "b"))).toMatchObject({
        rule: CONVERSATION_GRAMMAR_RULES.turnKnown,
      });
    });

    it("cannot move a part to another turn", () => {
      const g = new ConversationGrammar();
      g.observe("p", turn("t-1"));
      g.observe("p", turn("t-2"));
      g.observe("p", part("t-1", { id: "b", text: "Hel" }));
      expect(g.observe("p", text("t-2", "b"))).toMatchObject({
        rule: CONVERSATION_GRAMMAR_RULES.partOneTurn,
      });
    });

    it("cannot grow a part that already settled", () => {
      // Prose that went `done` is finished. A delta after it would put characters on a phone
      // that the page this host holds does not have.
      const g = new ConversationGrammar();
      g.observe("p", turn("t-1"));
      g.observe("p", part("t-1", { id: "b", text: "Hel" }));
      g.observe("p", part("t-1", { id: "b", text: "Hello", state: "done" }));
      expect(g.observe("p", text("t-1", "b"))).toMatchObject({
        rule: CONVERSATION_GRAMMAR_RULES.partSettlesOnce,
      });
    });
  });

  it("keeps panes apart, and forgets one that is gone", () => {
    const g = new ConversationGrammar();
    g.observe("p1", turn("t-1"));
    // Same turn id, different cell: the ids are only unique within a pane.
    expect(g.observe("p2", part("t-1", { id: "a" }))).toMatchObject({
      rule: CONVERSATION_GRAMMAR_RULES.turnKnown,
    });
    expect(g.size()).toBe(2);
    g.forget("p2");
    expect(g.size()).toBe(1);
  });
});
