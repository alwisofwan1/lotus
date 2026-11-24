import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertFixture } from "../../__tests__/support/fixtures.js";
import { NativeConversation } from "../native-conversation.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every notification the real binary sent for one turn, minus hook/MCP/account chatter. */
function replay(): NativeConversation {
  const c = new NativeConversation("ss-1");
  for (const line of readFileSync(join(HERE, "fixtures/app-server-turn.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as { method?: string; params?: unknown };
    if (msg.method !== undefined) c.apply(msg.method, msg.params);
  }
  return c;
}

describe("NativeConversation over a real app-server capture (0.150.1)", () => {
  it("yields one closed turn: prompt, commentary, a completed exec with its output, the answer, and a result", () => {
    const page = replay().page();
    expect(page.turns).toHaveLength(1);
    const [turn] = page.turns;
    expect(turn?.stopReason).toBe("end_turn");
    expect(turn?.parts.map((p) => p.type)).toEqual(["user_message", "assistant_text", "tool_call", "assistant_text", "result"]);
    const [prompt, commentary, exec, answer, result] = turn?.parts ?? [];
    expect(prompt).toMatchObject({ type: "user_message", provenance: "native" });
    expect(commentary).toMatchObject({ type: "assistant_text", text: "Running that exact command now.", state: "done" });
    expect(exec).toMatchObject({
      type: "tool_call", toolName: "exec", kind: "execute", status: "completed",
      title: "mkdir -p /tmp/lotus-probe-x && echo made",
      output: { text: "made\n", exitCode: 0 },
    });
    expect(answer).toMatchObject({ type: "assistant_text", text: "```text\nmade\n```", state: "done" });
    expect(result).toMatchObject({ type: "result", isError: false, durationMs: 90317, usage: { input: expect.any(Number), output: expect.any(Number) } });
  });

  /**
   * The contract's first **native** conversation page — what `/conversation` serves for a
   * cell this host runs itself. Committed so the Dart side parses provenance `native`, a
   * `result` part and an `output` on a tool call before any phone meets one.
   */
  it("rest-conversation-native is the replayed capture as the page /conversation serves", () => {
    assertFixture("rest-conversation-native", replay().page());
  });

  it("ids are Codex's own item ids, and an item upserted twice is one part", () => {
    const page = replay().page();
    const ids = page.turns[0]?.parts.map((p) => p.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[2]).toMatch(/^exec-/);
  });

  it("streams: deltas grow the assistant text while the item is open, and completion finishes it", () => {
    const c = new NativeConversation("ss-1");
    c.apply("turn/started", { turn: { id: "t1", startedAt: 1_787_839_311 } });
    c.apply("item/started", { turnId: "t1", startedAtMs: 1, item: { type: "agentMessage", id: "m1", text: "", phase: "final_answer" } });
    c.apply("item/agentMessage/delta", { turnId: "t1", itemId: "m1", delta: "po" });
    c.apply("item/agentMessage/delta", { turnId: "t1", itemId: "m1", delta: "ng" });
    let part = c.page().turns[0]?.parts[0];
    expect(part).toMatchObject({ type: "assistant_text", text: "pong", state: "streaming" });
    c.apply("item/completed", { turnId: "t1", completedAtMs: 2, item: { type: "agentMessage", id: "m1", text: "pong", phase: "final_answer" } });
    part = c.page().turns[0]?.parts[0];
    expect(part).toMatchObject({ text: "pong", state: "done" });
    expect(c.page().turns[0]?.parts).toHaveLength(1);
  });

  it("a command execution moves in_progress → completed, and a declined one is cancelled", () => {
    const c = new NativeConversation("ss-1");
    c.apply("turn/started", { turn: { id: "t1", startedAt: 1 } });
    const item = { type: "commandExecution", id: "e1", command: "/bin/zsh -lc 'ls'", commandActions: [{ type: "unknown", command: "ls" }], status: "inProgress", aggregatedOutput: null, exitCode: null };
    c.apply("item/started", { turnId: "t1", startedAtMs: 1, item });
    expect(c.page().turns[0]?.parts[0]).toMatchObject({ type: "tool_call", title: "ls", status: "in_progress" });
    c.apply("item/completed", { turnId: "t1", completedAtMs: 2, item: { ...item, status: "declined" } });
    expect(c.page().turns[0]?.parts[0]).toMatchObject({ status: "cancelled" });
  });

  it("a file change carries a per-file diffstat derived from the unified diff", () => {
    const c = new NativeConversation("ss-1");
    c.apply("turn/started", { turn: { id: "t1", startedAt: 1 } });
    c.apply("item/completed", { turnId: "t1", completedAtMs: 2, item: { type: "fileChange", id: "f1", status: "completed", changes: { "/Users/op/a.ts": { kind: "update", unified_diff: "@@ -1 +1,2 @@\n-old\n+new\n+newer" } } } });
    expect(c.page().turns[0]?.parts[0]).toMatchObject({
      type: "tool_call", toolName: "apply_patch", kind: "edit", title: "a.ts",
      diff: { files: [{ path: "/Users/op/a.ts", op: "modify", additions: 2, deletions: 1 }] },
    });
  });

  it("an approval request is a permission part with digit keys, answered by decide()", () => {
    // Shape from the generated schema (CommandExecutionRequestApprovalParams); the live
    // probes of 2026-08-27 never triggered one, so this is schema-derived, not captured.
    const c = new NativeConversation("ss-1");
    c.apply("turn/started", { turn: { id: "t1", startedAt: 1 } });
    const part = c.requestApproval("item/commandExecution/requestApproval", { turnId: "t1", itemId: "e1", command: "rm -rf build", approvalId: null }, "a0");
    expect(part).toMatchObject({ type: "permission", title: "Run rm -rf build?", toolCallId: "e1" });
    expect(part?.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(c.pendingPermission()?.requestId).toBe("a0");
    expect(c.decide("a0", "2")).toBe("acceptForSession");
    expect(c.pendingPermission()).toBeUndefined();
    expect(c.page().turns[0]?.parts[0]).toMatchObject({ type: "permission", outcome: { selected: "2" } });
  });

  it("an interrupted turn closes as cancelled, a failed one as error with the message", () => {
    const c = new NativeConversation("ss-1");
    c.apply("turn/started", { turn: { id: "t1", startedAt: 1 } });
    c.apply("turn/completed", { turn: { id: "t1", status: "interrupted", completedAt: 2 } });
    expect(c.page().turns[0]?.stopReason).toBe("cancelled");
    c.apply("turn/started", { turn: { id: "t2", startedAt: 3 } });
    c.apply("turn/completed", { turn: { id: "t2", status: "failed", completedAt: 4, error: { message: "quota" } } });
    expect(c.page().turns[1]?.stopReason).toBe("error");
    expect(c.page().turns[1]?.parts.at(-1)).toMatchObject({ type: "error", message: "quota" });
  });

  it("an item for a turn never seen opening still lands — a reconnect mid-turn", () => {
    const c = new NativeConversation("ss-1");
    c.apply("item/completed", { turnId: "t9", completedAtMs: 5, item: { type: "agentMessage", id: "m", text: "hi", phase: "final_answer" } });
    expect(c.page().turns).toHaveLength(1);
    expect(c.page().turns[0]?.turnId).toBe("t9");
  });
});
