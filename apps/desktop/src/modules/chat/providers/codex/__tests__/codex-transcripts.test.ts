import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { threadEventEnvelopeSchema, type ThreadEvent, type ThreadEventEnvelope } from "../../../domain/thread-event";
import { applyThreadEvents, emptyThreadState } from "../../../domain/thread-state";
import { buildTimelineRows } from "../../../domain/timeline";
import { codexPolicy, CodexTranslator, hunksOf, shownCommand } from "../translate";

// Real `codex app-server` streams (codex-cli 0.164.0), recorded by a probe and stripped to the
// turn and item messages. The recording approved every command and declined the one patch.

const input = { text: "do the thing", clientRequestId: "req-1" };

function replay(name: string) {
  const translator = new CodexTranslator();
  const envelopes: ThreadEventEnvelope[] = [];
  const emit = (events: ThreadEvent[]) => {
    for (const event of events) envelopes.push({ threadId: name, seq: envelopes.length + 1, at: envelopes.length, event });
  };
  emit(translator.translate({ method: "lotus/configured", params: { threadId: "codex-thread", model: "gpt-6.1-sol", cwd: "/work", account: { type: "chatgpt" } } }));
  translator.noteInput(input, "u1");
  emit(translator.translate({ method: "lotus/turnSent", params: { uuid: "u1" } }));
  const lines = readFileSync(path.resolve(__dirname, "../__fixtures__", `${name}.jsonl`), "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const msg = JSON.parse(line) as { id?: number; method: string; params: Record<string, unknown> };
    if (msg.id !== undefined) {
      const notice = translator.permission(msg.method, msg.params);
      if (!notice) continue;
      const id = `interaction-${msg.id}`;
      emit(translator.interactionRequested(id, notice));
      emit(translator.interactionResolved(id, msg.method.includes("fileChange") ? { behavior: "deny", message: "no" } : { behavior: "allow" }));
    } else {
      emit(translator.translate(msg));
    }
  }
  emit(translator.end(null));
  const events = envelopes.map((e) => e.event);
  const state = applyThreadEvents(emptyThreadState(name), envelopes);
  return { envelopes, events, state, rows: buildTimelineRows(state) };
}

const completed = (events: ThreadEvent[]) => events.flatMap((e) => (e.type === "item/completed" ? [e.item] : []));

describe("Codex transcripts → ThreadEvents", () => {
  it.each(["command-approvals", "edit-declined", "interrupted"])("%s: every event matches the wire schema, one turn", (name) => {
    const { envelopes, events } = replay(name);
    for (const envelope of envelopes) expect(threadEventEnvelopeSchema.safeParse(envelope).success, JSON.stringify(envelope.event)).toBe(true);
    expect(events.filter((e) => e.type === "turn/started")).toEqual([expect.objectContaining({ input })]);
    expect(events.filter((e) => e.type === "turn/completed")).toHaveLength(1);
    const started = events.flatMap((e) => (e.type === "item/started" ? [e.item.id] : []));
    expect(new Set(completed(events).map((i) => i.id))).toEqual(new Set(started));
  });

  it.each(["command-approvals", "edit-declined"])("%s: says the turn is answered once, when the final answer lands, before turn/completed", (name) => {
    const types = replay(name).events.map((e) => e.type);
    expect(types.filter((t) => t === "turn/answered")).toHaveLength(1);
    const answered = types.indexOf("turn/answered");
    expect(answered).toBeLessThan(types.indexOf("turn/completed"));
    expect(types.slice(answered + 1).filter((t) => t === "item/started")).toEqual([]);
  });

  it("an interrupted answer is never answered", () => {
    expect(replay("interrupted").events.some((e) => e.type === "turn/answered")).toBe(false);
  });

  it("reports the ChatGPT login and the Codex thread as the session", () => {
    expect(replay("interrupted").events[0]).toMatchObject({ type: "session/configured", providerSessionId: "codex-thread", authSource: "accountLogin" });
  });

  it("shows commands without their shell, with output, and the answer", () => {
    const { events, rows } = replay("command-approvals");
    const commands = completed(events).filter((i) => i.kind === "command");
    expect(commands.map((c) => c.kind === "command" && c.command)).toEqual(["ls", "ls -1A", "printf 'hi' > note.txt"]);
    expect(commands[0]).toMatchObject({ status: "completed", output: "a.txt\nb.txt\n" });
    expect(events.find((e) => e.type === "interaction/requested")).toMatchObject({ interaction: { toolName: "Bash", input: { command: "ls" } } });
    expect(rows.at(-1)).toMatchObject({ kind: "assistant" });
    expect(events.find((e) => e.type === "turn/completed")).toMatchObject({ status: "completed", usage: { inputTokens: 58_914, outputTokens: 131, durationMs: 9238, contextTokens: 29_602, contextWindow: 475_000 } });
  });

  it("splits a declined patch into one declined item per file, asked as an edit", () => {
    const { events } = replay("edit-declined");
    const files = completed(events).filter((i) => i.kind === "fileChange");
    expect(files).toEqual([
      expect.objectContaining({ path: "/work/README.md", change: "create", status: "declined", patch: null }),
      expect.objectContaining({ path: "/work/math.js", change: "edit", status: "declined", patch: null }),
    ]);
    const asked = events.filter((e) => e.type === "interaction/requested").at(-1);
    expect(asked).toMatchObject({ interaction: { toolName: "Write", input: { file_path: "/work/README.md", files: ["/work/README.md", "/work/math.js"] } } });
  });

  it("closes the message an interrupt cut off", () => {
    const { events } = replay("interrupted");
    expect(events.find((e) => e.type === "turn/completed")).toMatchObject({ status: "interrupted" });
    expect(completed(events)).toEqual([expect.objectContaining({ kind: "agentMessage", status: "interrupted" })]);
  });

  it("shows a steer inside the running turn", () => {
    const t = new CodexTranslator();
    t.noteInput(input, "u1");
    t.translate({ method: "lotus/turnSent", params: { uuid: "u1" } });
    t.translate({ method: "turn/started", params: { turn: { id: "t1" } } });
    t.noteInput({ text: "also this", clientRequestId: "req-2" }, "u2");
    expect(t.translate({ method: "lotus/steered", params: { uuid: "u2" } })).toEqual([
      { type: "item/completed", turnId: "t1", item: { id: "steer-u2", status: "completed", kind: "userMessage", text: "also this", clientRequestId: "req-2" } },
    ]);
  });
});

describe("Codex helpers", () => {
  it("unwraps the login shell around a command", () => {
    expect(shownCommand({ command: "/bin/zsh -lc 'echo '\\''x'\\'''" })).toBe("echo 'x'");
    expect(shownCommand({ command: '/bin/bash -lc "a \\"b\\""' })).toBe('a "b"');
    expect(shownCommand({ command: "git status" })).toBe("git status");
  });

  it("reads a unified diff, and a new file's content", () => {
    expect(hunksOf("@@ -1 +1 @@\n-a\n+b\n", false)).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }]);
    expect(hunksOf("x\ny\n", true)).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+x", "+y"] }]);
  });

  it("asks about an MCP tool call like a Claude tool; other elicitations stay unasked", () => {
    // Shape captured from codex app-server 2026-11-01.
    const params = {
      serverName: "lotus-dev",
      mode: "form",
      message: 'Allow the lotus-dev MCP server to run tool "lotus_chat_read"?',
      _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: { chatId: "c1" } },
      requestedSchema: { type: "object", properties: {} },
    };
    const translator = new CodexTranslator();
    expect(translator.permission("mcpServer/elicitation/request", params)).toEqual({
      toolName: "mcp__lotus-dev__lotus_chat_read",
      toolUseId: null,
      input: { chatId: "c1" },
      blockedPath: null,
      remember: true,
    });
    expect(translator.permission("mcpServer/elicitation/request", { ...params, _meta: {} })).toBeNull();
  });

  it("maps the four modes onto sandbox × approval", () => {
    expect(codexPolicy("plan")).toEqual({ sandbox: "read-only", approvalPolicy: "on-request" });
    expect(codexPolicy("default")).toEqual({ sandbox: "workspace-write", approvalPolicy: "untrusted" });
    expect(codexPolicy("acceptEdits")).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request" });
    expect(codexPolicy("bypassPermissions")).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
  });

  it("counts a turn's spend from the running total, not earlier turns and not one call", () => {
    const tr = new CodexTranslator();
    const u = (total: [number, number], last: [number, number]) => ({
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { total: { inputTokens: total[0], outputTokens: total[1] }, last: { inputTokens: last[0], outputTokens: last[1] } } },
    });
    const turn = (id: string) => [
      { method: "turn/started", params: { turn: { id } } },
      ...(id === "t1" ? [u([100, 10], [100, 10]), u([300, 30], [200, 20])] : [u([700, 70], [400, 40])]),
      { method: "turn/completed", params: { turn: { id, status: "completed" } } },
    ];
    const usages = [...turn("t1"), ...turn("t2")]
      .flatMap((m) => tr.translate(m))
      .flatMap((e) => (e.type === "turn/completed" ? [e.usage] : []));
    expect(usages.map((x) => [x?.inputTokens, x?.outputTokens])).toEqual([[300, 30], [400, 40]]);
  });
});
