import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ConversationUpdate, ToolCallPart } from "../../../../../../types/conversation.js";
import { AcpConversation } from "../conversation.js";
import type { AcpUpdate } from "../parts.js";

/**
 * A real `cursor-agent acp` turn, captured 2026-09-06 by driving the binary through
 * `initialize` → `authenticate` → `session/new` → `session/prompt` and recording every
 * inbound `session/update`. The prompt was "Read notes.txt, then add a line 'delta' to the
 * end of it. Then run the shell command: echo done" in a scratch workspace.
 *
 * Trimmed in exactly one place: `available_commands_update` kept two of its commands, because
 * the operator's slash-command list is long, machine-specific, and not what this asserts.
 */
function fixture(): AcpUpdate[] {
  const raw = readFileSync(join(__dirname, "fixtures", "cursor-acp-turn.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (JSON.parse(l) as { update: AcpUpdate }).update);
}

function replay(): AcpConversation {
  const c = new AcpConversation("ss-acp", "cursor");
  c.openTurn("Read notes.txt, then add a line 'delta' to the end of it. Then run the shell command: echo done");
  for (const u of fixture()) c.apply(u);
  c.closeTurn("end_turn");
  return c;
}

describe("AcpConversation, against the captured cursor-agent turn", () => {
  it("puts the whole turn in one turn, opened by the prompt and closed by the stop reason", () => {
    const page = replay().page();
    expect(page.turns).toHaveLength(1);
    const turn = page.turns[0];
    expect(turn?.stopReason).toBe("end_turn");
    expect(turn?.endedAt).toBeDefined();
    expect(turn?.parts[0]).toMatchObject({ type: "user_message" });
  });

  it("collapses 46 message chunks into one growing assistant_text, settled at the end", () => {
    const parts = replay().page().turns[0]?.parts ?? [];
    const texts = parts.filter((p) => p.type === "assistant_text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ state: "done" });
    const text = texts[0]?.type === "assistant_text" ? texts[0].text : "";
    expect(text).toContain("I'll read `notes.txt`");
    expect(text).toContain("Appended `delta`");
  });

  /**
   * The test above says the **page** collapses 46 chunks into one part. It always did. What
   * nothing checked was what those 46 chunks cost on the wire, and the answer was 46 copies
   * of a growing prefix — across a tailnet, to a phone.
   */
  it("spells the reply once on the wire, not once per chunk", () => {
    const c = new AcpConversation("ss-acp", "cursor");
    const wire: ConversationUpdate[] = [];
    c.onUpdate((u) => wire.push(u));
    c.openTurn("go");
    for (const u of fixture()) c.apply(u);
    c.closeTurn("end_turn");

    // Per part, because the two streaming lanes settle differently: prose is re-sent whole
    // when the turn closes, reasoning never is.
    const cost = (partId: string): number =>
      wire.reduce(
        (n, u) =>
          n +
          (u.kind === "text" && u.partId === partId
            ? u.delta.length
            : u.kind === "part" && u.part.id === partId && "text" in u.part
              ? u.part.text.length
              : 0),
        0,
      );
    const held = (partId: string): number => {
      const part = (c.page().turns[0]?.parts ?? []).find((p) => p.id === partId);
      return part !== undefined && "text" in part ? part.text.length : 0;
    };
    const prose = (c.page().turns[0]?.parts ?? []).find((p) => p.type === "assistant_text");
    const thought = (c.page().turns[0]?.parts ?? []).find((p) => p.type === "reasoning");

    // Prose crosses exactly twice: spelled once as it streams, and once more when the turn
    // closes and settles it to `done`. Reasoning crosses exactly once — nothing settles it.
    expect(cost(prose?.id ?? "")).toBe(held(prose?.id ?? "") * 2);
    expect(cost(thought?.id ?? "")).toBe(held(thought?.id ?? ""));
    // Re-sending the growing part per chunk cost the sum of 46 prefixes instead.
    expect(wire.filter((u) => u.kind === "text").length).toBeGreaterThan(20);
  });

  it("keeps reasoning in its own part, never mixed into the prose", () => {
    const parts = replay().page().turns[0]?.parts ?? [];
    const thoughts = parts.filter((p) => p.type === "reasoning");
    expect(thoughts).toHaveLength(1);
    const thought = thoughts[0]?.type === "reasoning" ? thoughts[0].text : "";
    expect(thought).toContain("Reading notes.txt");
    const prose = parts.find((p) => p.type === "assistant_text");
    expect(prose?.type === "assistant_text" ? prose.text : "").not.toContain("Reading notes.txt");
  });

  it("folds each tool call's four updates into one part that ends completed", () => {
    const calls = tools(replay());
    expect(calls.map((c) => c.title)).toEqual([
      expect.stringContaining("Read notes.txt"),
      expect.stringContaining("Edit `"),
      "`echo done`",
    ]);
    expect(calls.map((c) => c.kind)).toEqual(["read", "edit", "execute"]);
    expect(calls.every((c) => c.status === "completed")).toBe(true);
  });

  it("keeps the tool's name from the title it first arrived with", () => {
    // `Read File` then retitled `Read notes.txt`: ACP carries no separate tool identifier.
    expect(tools(replay()).map((c) => c.toolName)).toEqual(["Read File", "Edit File", "`echo done`"]);
  });

  it("folds the newline out of every toolCallId", () => {
    const calls = tools(replay());
    expect(calls.every((c) => !c.toolCallId.includes("\n"))).toBe(true);
    expect(calls[0]?.toolCallId).toMatch(/^call-[0-9a-f-]+-0 fc_[0-9a-f-]+_0$/);
  });

  it("counts the edit from the diff the agent sent, not from a hunk header", () => {
    const edit = tools(replay())[1];
    expect(edit?.diff?.files).toEqual([
      { path: expect.stringContaining("notes.txt"), op: "modify", additions: 1, deletions: 0 },
    ]);
  });

  it("carries the shell exit code and stdout", () => {
    expect(tools(replay())[2]?.output).toEqual({ text: "done\n", exitCode: 0, truncated: false });
  });

  it("reads the file the agent showed it, as the read tool's output", () => {
    expect(tools(replay())[0]?.output?.text).toBe("alpha\nbeta\ngamma\n");
  });

  it("takes the session title the agent chose, and renders no part for it", () => {
    const c = replay();
    expect(c.title).toBe("Append To File");
    expect(c.page().turns[0]?.parts.some((p) => p.type === "unknown")).toBe(false);
  });

  it("reports what ACP actually gives, per dimension", () => {
    const caps = replay().page().capabilities;
    expect(caps).toMatchObject({ streaming: "expected", diff: "expected", toolStatus: "expected" });
    // Probed 2026-09-06: Cursor over ACP ran `rm -f` and a network call with no request.
    expect(caps.permission).toBe("never");
  });
});

describe("AcpConversation, shapes the capture did not contain", () => {
  it("does not throw on an update it has never seen, and keeps it as unknown", () => {
    const c = new AcpConversation("ss-acp", "cursor");
    c.openTurn();
    c.apply({ sessionUpdate: "something_new_in_v2", payload: { a: 1 } });
    const parts = c.page().turns[0]?.parts ?? [];
    expect(parts.at(-1)).toMatchObject({ type: "unknown", rawType: "something_new_in_v2" });
  });

  it("records a permission request and answers it by option id, never by position", () => {
    const c = new AcpConversation("ss-acp", "cursor");
    c.openTurn();
    const part = c.requestPermission("r-1", {
      toolCall: { toolCallId: "call-9\nfc_9", title: "Run `rm -rf /`" },
      options: [
        { optionId: "reject", name: "No", kind: "reject_once" },
        { optionId: "allow", name: "Yes", kind: "allow_once" },
      ],
    });
    expect(part).toMatchObject({ title: "Run `rm -rf /`", toolCallId: "call-9 fc_9" });
    expect(c.pendingPermission()?.requestId).toBe("r-1");
    expect(c.decide("r-1", "2")).toBeUndefined();
    expect(c.decide("r-1", "allow")).toBe("allow");
    expect(c.pendingPermission()).toBeUndefined();
  });

  it("attributes an update that arrives with no open turn rather than dropping it", () => {
    const c = new AcpConversation("ss-acp", "cursor");
    c.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "orphan" } });
    expect(c.page().turns).toHaveLength(1);
    expect(c.page().turns[0]?.parts[0]).toMatchObject({ type: "assistant_text", text: "orphan" });
  });

  it("marks a failed turn as an error and keeps the message", () => {
    const c = new AcpConversation("ss-acp", "cursor");
    c.openTurn("go");
    c.closeTurn(undefined, "agent exited");
    const turn = c.page().turns[0];
    expect(turn?.stopReason).toBe("error");
    expect(turn?.parts.at(-1)).toMatchObject({ type: "error", message: "agent exited" });
  });

  it("reads a refusal and a cancellation as themselves", () => {
    const refused = new AcpConversation("ss-a", "cursor");
    refused.openTurn("go");
    refused.closeTurn("refusal");
    expect(refused.page().turns[0]?.stopReason).toBe("error");

    const stopped = new AcpConversation("ss-b", "cursor");
    stopped.openTurn("go");
    stopped.closeTurn("cancelled");
    expect(stopped.page().turns[0]?.stopReason).toBe("cancelled");
  });

  it("records a mode change as a part and remembers the mode", () => {
    const c = new AcpConversation("ss-acp", "cursor");
    c.openTurn();
    c.apply({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    expect(c.mode).toBe("plan");
    expect(c.page().turns[0]?.parts.at(-1)).toMatchObject({ type: "mode_change", modeId: "plan" });
  });

  it("keeps a plan as a checklist and drops an entry it cannot read", () => {
    const c = new AcpConversation("ss-acp", "cursor");
    c.openTurn();
    c.apply({
      sessionUpdate: "plan",
      entries: [
        { content: "read", priority: "high", status: "completed" },
        { content: "write", priority: "nonsense", status: "nonsense" },
        { nothing: true },
      ],
    });
    expect(c.page().turns[0]?.parts.at(-1)).toMatchObject({
      type: "plan_update",
      entries: [
        { content: "read", priority: "high", status: "completed" },
        { content: "write", priority: "medium", status: "pending" },
      ],
    });
  });
});

function tools(c: AcpConversation): ToolCallPart[] {
  return (c.page().turns[0]?.parts ?? []).filter((p): p is ToolCallPart => p.type === "tool_call");
}
