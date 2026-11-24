import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ConversationUpdate, ToolCallPart } from "../../../../../../types/conversation.js";
import { ClaudeConversation } from "../conversation.js";
import type { ClaudeMessage } from "../messages.js";

/**
 * A real turn from `claude --print --output-format stream-json --include-partial-messages`,
 * captured 2026-09-07 by driving the binary with `--input-format stream-json` and asking it
 * to "Read notes.txt and then append a line 'gamma' to it".
 *
 * Trimmed in two places: the `SessionStart` hook chatter is dropped (it is this machine's
 * own hooks, not the protocol), and six of the partial text deltas are kept rather than all
 * of them — enough to prove they assemble into one part.
 */
function fixture(): ClaudeMessage[] {
  const raw = readFileSync(join(__dirname, "fixtures", "claude-stream-turn.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ClaudeMessage);
}

function replay(): ClaudeConversation {
  const c = new ClaudeConversation("ss-claude");
  c.openTurn("Read notes.txt and then append a line 'gamma' to it.");
  for (const m of fixture()) c.apply(m);
  return c;
}

/** The same turn, with everything the bridge put **on the wire** kept in order. */
function replayWire(): { conversation: ClaudeConversation; wire: ConversationUpdate[] } {
  const conversation = new ClaudeConversation("ss-claude");
  const wire: ConversationUpdate[] = [];
  conversation.onUpdate((u) => wire.push(u));
  conversation.openTurn("Read notes.txt and then append a line 'gamma' to it.");
  for (const m of fixture()) conversation.apply(m);
  return { conversation, wire };
}

function tools(c: ClaudeConversation): ToolCallPart[] {
  return (c.page().turns[0]?.parts ?? []).filter((p): p is ToolCallPart => p.type === "tool_call");
}

describe("ClaudeConversation, against the captured stream-json turn", () => {
  it("closes the turn on result, with the runner's own session id", () => {
    const c = replay();
    const turn = c.page().turns[0];
    expect(c.page().turns).toHaveLength(1);
    expect(turn?.stopReason).toBe("end_turn");
    expect(turn?.endedAt).toBeDefined();
    expect(c.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("pairs every tool call with the result that answered it", () => {
    // Two `Bash` calls, not a Read and an Edit: the runner chose the shell for both, which
    // is exactly why the kind is read from the tool name rather than from the prompt.
    const calls = tools(replay());
    expect(calls.map((c) => c.toolName)).toEqual(["Bash", "Bash"]);
    expect(calls.map((c) => c.kind)).toEqual(["execute", "execute"]);
    expect(calls.every((c) => c.status === "completed")).toBe(true);
    // The pairing the hook pipeline could only guess at, by name.
    expect(calls[0]?.toolCallId).toMatch(/^toolu_/);
    expect(calls[0]?.output?.text).toContain("alpha");
  });

  it("names what each tool acted on, from that tool's own input shape", () => {
    // `Bash` names itself by its command, where a file tool would name itself by its path.
    expect(tools(replay())[0]?.title).toContain("notes.txt");
  });

  it("draws no reasoning part for a thinking block that carries no text", () => {
    // The capture has one `thinking` block and it is empty — the runner reported that it
    // thought without saying what. An empty part on screen would be worse than none.
    const parts = replay().page().turns[0]?.parts ?? [];
    expect(parts.filter((p) => p.type === "reasoning")).toHaveLength(0);
  });

  it("keeps thinking as its own part when there is any", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    c.apply({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "weighing it" }] },
    });
    expect((c.page().turns[0]?.parts ?? []).at(-1)).toMatchObject({
      type: "reasoning",
      text: "weighing it",
    });
  });

  it("assembles the deltas into the same part the whole message settles", () => {
    const texts = (replay().page().turns[0]?.parts ?? []).filter((p) => p.type === "assistant_text");
    // Never one part per chunk: the deltas grow a part the `assistant` message then closes.
    expect(texts.every((p) => p.type === "assistant_text" && p.state === "done")).toBe(true);
    expect(texts.length).toBeLessThan(4);
  });

  /**
   * The page has always been right about streaming; the **wire** was not, and no test looked
   * at it. Re-sending the growing part per chunk costs the sum of its prefixes, which is
   * quadratic in the length of a reply — on the one lane that crosses a tailnet to a phone.
   */
  describe("what streaming actually puts on the wire", () => {
    it("opens the text part once and then sends only what was added", () => {
      const { wire } = replayWire();
      const opens = wire.filter((u) => u.kind === "part" && u.part.type === "assistant_text");
      const deltas = wire.filter((u) => u.kind === "text");
      expect(opens.length).toBeGreaterThan(0);
      expect(deltas.length).toBeGreaterThan(0);
      // Every delta names a part some `part` update opened first — the rule that lets a
      // client apply one blindly (`part/opens-before-delta`).
      const opened = new Set(opens.map((u) => (u.kind === "part" ? u.part.id : "")));
      expect(deltas.every((u) => u.kind === "text" && opened.has(u.partId))).toBe(true);
    });

    /**
     * The capture cannot show the cost — it was trimmed to two text deltas, and two chunks
     * is where the two shapes are nearly the same price. So the cost is measured against a
     * reply of the length a real one has, chunked the way the CLI chunks one.
     */
    it("puts a long reply on the wire once over, not once per prefix", () => {
      const c = new ClaudeConversation("ss-claude");
      const wire: ConversationUpdate[] = [];
      c.onUpdate((u) => wire.push(u));
      c.openTurn("write it out");
      const chunks = Array.from({ length: 200 }, () => "twenty characters!! ");
      for (const text of chunks) {
        c.apply({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
      }
      const reply = chunks.join("");
      const streamed = wire.reduce(
        (n, u) =>
          n +
          (u.kind === "text"
            ? u.delta.length
            : u.kind === "part" && u.part.type === "assistant_text"
              ? u.part.text.length
              : 0),
        0,
      );
      // The reply spelled **exactly once** across the wire: the first chunk inside the part
      // that opened it, every later chunk as itself. The old shape sent a prefix per chunk —
      // 200 chunks of 20 characters cost 402,000, not 4,000.
      expect(streamed).toBe(reply.length);
      expect(wire.filter((u) => u.kind === "part" && u.part.type === "assistant_text")).toHaveLength(1);
      expect(wire.filter((u) => u.kind === "text")).toHaveLength(chunks.length - 1);
      // And the page is still the whole reply — the record never depended on the deltas.
      const held = (c.page().turns[0]?.parts ?? []).find((p) => p.type === "assistant_text");
      expect(held?.type === "assistant_text" ? held.text : "").toBe(reply);
    });

    it("still ends holding the whole reply for a client that ignored every delta", () => {
      const { conversation, wire } = replayWire();
      const fromParts = new Map<string, string>();
      for (const u of wire) {
        if (u.kind === "part" && u.part.type === "assistant_text") fromParts.set(u.part.id, u.part.text);
      }
      // This is what makes the kind additive (ADR-4): a phone built before it applies the
      // `part` updates alone and lands on exactly the page this host holds.
      for (const part of conversation.page().turns[0]?.parts ?? []) {
        if (part.type !== "assistant_text") continue;
        expect(fromParts.get(part.id)).toBe(part.text);
      }
    });
  });

  it("reads the rate-limit window the runner volunteers", () => {
    // The answer to G8: on Cursor an exhausted plan was indistinguishable from an answer.
    expect(replay().rateLimit).toMatchObject({ status: "allowed", window: "five_hour" });
  });

  it("says nothing about a healthy plan", () => {
    // A notice per turn on a plan that is fine would be a line of noise per step.
    const parts = replay().page().turns[0]?.parts ?? [];
    expect(parts.filter((p) => p.type === "error")).toHaveLength(0);
  });

  it("closes with usage and cost from the runner, not from a count of its own", () => {
    const result = (replay().page().turns[0]?.parts ?? []).find((p) => p.type === "result");
    expect(result).toMatchObject({ type: "result", isError: false });
    expect(result?.type === "result" ? result.costUsd : undefined).toBeGreaterThan(0);
    expect(result?.type === "result" ? result.usage : undefined).toBeDefined();
  });

  it("reports what this wire actually gives, per dimension", () => {
    const caps = replay().page().capabilities;
    expect(caps).toMatchObject({ streaming: "expected", reasoning: "expected", usage: "expected" });
    // `never` until Fase 3b: the runner now asks through an MCP tool and waits for the answer.
    expect(caps.permission).toBe("expected");
  });
});

describe("ClaudeConversation, shapes the capture did not contain", () => {
  it("turns a refused tool into a failed step, which is the only trace it leaves", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("delete it");
    c.apply({
      type: "result",
      stop_reason: "end_turn",
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "toolu_9", tool_input: { command: "rm -f doomed.txt" } },
      ],
    });
    const denied = tools(c)[0];
    expect(denied).toMatchObject({ toolName: "Bash", status: "failed", title: "rm -f doomed.txt" });
    expect(denied?.output?.text).toContain("denied");
  });

  it("holds a question the runner asked, and answers it by printed digit", () => {
    const c = replay();
    expect(c.pendingPermission()).toBeUndefined();
    c.requestPermission("r-1", {
      toolName: "Bash",
      toolUseId: "toolu_9",
      input: { command: "rm -rf build" },
    });
    expect(c.pendingPermission()).toMatchObject({
      requestId: "r-1",
      toolCallId: "toolu_9",
      title: "Bash rm -rf build",
    });
    // ADR-8: the digit, never the position.
    expect(c.decide("r-1", "9")).toBeUndefined();
    expect(c.decide("r-1", "1")).toMatchObject({ kind: "allow_once" });
    expect(c.pendingPermission()).toBeUndefined();
  });

  it("names the tool alone when its input says nothing about a target", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    const part = c.requestPermission("r-2", { toolName: "TodoWrite", toolUseId: "", input: {} });
    expect(part.type === "permission" ? part.title : "").toBe("TodoWrite");
    expect(part).not.toHaveProperty("toolCallId");
  });

  it("does not throw on a message it has never seen, and keeps it as unknown", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn();
    c.apply({ type: "something_new" });
    expect((c.page().turns[0]?.parts ?? []).at(-1)).toMatchObject({
      type: "unknown",
      rawType: "something_new",
    });
  });

  it("reads an errored turn as an error, whatever it says it stopped for", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    c.apply({ type: "result", stop_reason: "end_turn", is_error: true });
    expect(c.page().turns[0]?.stopReason).toBe("error");
  });

  it("says it in the transcript the moment the plan stops allowing", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    c.apply({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } });
    expect((c.page().turns[0]?.parts ?? []).filter((p) => p.type === "error")).toHaveLength(0);

    c.apply({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1788763800 },
    });
    const said = (c.page().turns[0]?.parts ?? []).at(-1);
    expect(said).toMatchObject({ type: "error", recoverable: true });
    expect(said?.type === "error" ? said.message : "").toContain("five_hour plan limit: rejected");
    expect(said?.type === "error" ? said.message : "").toContain("1788763800");

    // The same status again is the same fact, and must not add a second line.
    c.apply({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1788763800 },
    });
    expect((c.page().turns[0]?.parts ?? []).filter((p) => p.type === "error")).toHaveLength(1);
  });

  it("leaves usage absent when the runner reported none", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    c.apply({ type: "result", stop_reason: "end_turn" });
    const result = (c.page().turns[0]?.parts ?? []).find((p) => p.type === "result");
    expect(result).not.toHaveProperty("usage");
    expect(result).not.toHaveProperty("costUsd");
  });
});

/**
 * `AskUserQuestion` is the one gated tool that is not asking permission. Until 2026-09-08 it
 * arrived here as any other tool did — a card reading `AskUserQuestion` above **Allow once**
 * and **Deny**, with the question and its options dropped before the operator saw them.
 */
describe("a question the runner is putting to the operator", () => {
  const asking = {
    questions: [
      {
        question: "Tabs or spaces?",
        header: "Indentation",
        options: [
          { label: "Spaces", description: "Indent with spaces." },
          { label: "Tabs", description: "Indent with tab characters." },
        ],
      },
    ],
  };

  it("is recorded as a question part, not a permission wearing a flag", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    c.requestPermission("perm-0", { toolName: "AskUserQuestion", toolUseId: "toolu_1", input: asking });

    const parts = c.page().turns[0]?.parts ?? [];
    expect(parts.filter((p) => p.type === "permission")).toHaveLength(0);
    const question = parts.find((p) => p.type === "question");
    expect(question).toMatchObject({ type: "question", requestId: "perm-0", toolCallId: "toolu_1" });
    // Every option keeps its own sentence — the thing a permission's `{key,label}` threw away,
    // so a headless cell showed "Spaces" with nothing to say what choosing it means.
    expect(question?.type === "question" ? question.questions[0]?.options : []).toEqual([
      { key: "1", label: "Spaces", description: "Indent with spaces." },
      { key: "2", label: "Tabs", description: "Indent with tab characters." },
    ]);
  });

  /**
   * The id a session releases the runner by. A question is not a `permission` part any more,
   * so a lookup that only knew about permissions would leave the runner waiting for an answer
   * the operator had already given.
   */
  it("names itself as the request the cell is holding", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    c.requestPermission("perm-0", { toolName: "AskUserQuestion", toolUseId: "toolu_1", input: asking });

    expect(c.pendingRequestId()).toBe("perm-0");
    c.decide("perm-0", "1");
    expect(c.pendingRequestId()).toBeUndefined();
  });

  it("is answered by its printed digit, as everything on this wire is", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    c.requestPermission("perm-0", { toolName: "AskUserQuestion", toolUseId: "toolu_1", input: asking });

    expect(c.pendingQuestion()?.requestId).toBe("perm-0");
    expect(c.decide("perm-0", "2")?.label).toBe("Tabs");
    expect(c.pendingQuestion()).toBeUndefined();
  });

  it("is recorded as the question itself, answerable by its own options", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    const part = c.requestPermission("perm-0", {
      toolName: "AskUserQuestion",
      toolUseId: "toolu_1",
      input: asking,
    });

    // Printed digits, as every other bridge answers (ADR-8) — and the runner's own labels,
    // never paraphrased, with the sentence under each one kept.
    expect(part.type === "question" ? part.questions[0]?.question : "").toBe("Tabs or spaces?");
    expect(part.type === "question" ? part.questions[0]?.options : []).toEqual([
      { key: "1", label: "Spaces", description: "Indent with spaces." },
      { key: "2", label: "Tabs", description: "Indent with tab characters." },
    ]);
  });

  /**
   * And it falls back to **two** answers, never three. A session grant for `AskUserQuestion`
   * would let every later question through unasked — and a question that runs unasked returns
   * *"No answer received"*, so the agent would be told nobody replied, over and over, with the
   * operator never seeing a card. The one grant that must not exist.
   */
  it("still falls back to allow or deny for a shape it cannot put as one choice", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    const part = c.requestPermission("perm-0", {
      toolName: "AskUserQuestion",
      toolUseId: "toolu_1",
      input: { questions: [{ question: "A?", options: [] }] },
    });

    expect(part.type).toBe("permission");
    const options = part.type === "permission" ? part.options : [];
    expect(options.map((o) => o.key)).toEqual(["1", "2"]);
    expect(options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
  });

  it("leaves every other tool asking for permission, as it always did", () => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    const part = c.requestPermission("perm-0", {
      toolName: "Bash",
      toolUseId: "toolu_2",
      input: { command: "rm -f notes.txt" },
    });

    expect(part.type === "permission" ? part.title : "").toContain("rm -f notes.txt");
    expect(part.type === "permission" ? part.options.map((o) => o.label) : []).toEqual([
      "Allow once",
      "Allow all Bash until this cell closes",
      "Deny",
    ]);
  });
});

/**
 * "Allow once" was the only grant this bridge could offer, and the file said why: an *always*
 * would have to be enforced by this host rather than by the runner — a policy engine, not a
 * bridge. **Probed 2026-09-08 and that turned out to be wrong.** `--permission-prompt-tool`
 * accepts `updatedPermissions`, and the runner honours it: two Bash calls behind one grant were
 * asked about **once**, against twice in the control.
 *
 * What the probe did *not* buy is precision. The channel carries no `suggestions`, so the only
 * rule Lotus can compose is the tool's own name — and that is why the label has to say so.
 */
describe("granting a tool for the rest of the cell", () => {
  const ask = (toolName: string, input: Record<string, unknown> = {}) => {
    const c = new ClaudeConversation("ss-claude");
    c.openTurn("go");
    return c.requestPermission("perm-0", { toolName, toolUseId: "toolu_1", input });
  };

  it("offers it as a third answer, between once and never", () => {
    const part = ask("Bash", { command: "rm -f doomed.txt" });

    const opts = part.type === "permission" ? part.options : [];
    expect(opts.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(opts.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
  });

  /**
   * **The label is the safety feature, not the grant.** A button reading "Allow for session"
   * over a rule that admits every `Bash` is a wider permission than the words promise — and the
   * operator only ever reads the words. So it names the tool and the lifetime, literally.
   */
  it("says what it actually grants: the tool, and how long", () => {
    const asked = ask("Bash", { command: "rm -f doomed.txt" });
    const label = (asked.type === "permission" ? asked.options[1]?.label : "") ?? "";

    expect(label).toContain("Bash");
    expect(label.toLowerCase()).toContain("until this cell closes");
    // Not the command. The rule cannot be that narrow, so the label must not imply it is.
    expect(label).not.toContain("rm -f");
  });

  it("does not offer it for a question, whose options are the answers", () => {
    const part = ask("AskUserQuestion", {
      questions: [{ question: "Tabs or spaces?", options: [{ label: "Spaces" }, { label: "Tabs" }] }],
    });

    expect(part.type === "question" ? part.questions[0]?.options.map((o) => o.label) : []).toEqual([
      "Spaces",
      "Tabs",
    ]);
  });
});
