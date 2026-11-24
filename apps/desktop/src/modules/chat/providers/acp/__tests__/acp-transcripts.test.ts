import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { threadEventEnvelopeSchema, type ThreadEvent, type ThreadEventEnvelope } from "../../../domain/thread-event";
import { applyThreadEvents, emptyThreadState } from "../../../domain/thread-state";
import { buildTimelineRows } from "../../../domain/timeline";
import { AcpTranslator, toolName } from "../translate";

// A real `agy acp` turn (agy 1.5.9, 2026-11-19): read a file, run one command after an Allow, answer.
// Stripped to session/update, the permission request and the prompt's result; paths shortened to /work.

const input = { text: "read and run", clientRequestId: "req-1" };

function replay(opts: { interrupt?: boolean } = {}) {
  const translator = new AcpTranslator();
  const envelopes: ThreadEventEnvelope[] = [];
  const emit = (events: ThreadEvent[]) => {
    for (const event of events) envelopes.push({ threadId: "t", seq: envelopes.length + 1, at: envelopes.length, event });
  };
  emit(translator.translate({ method: "lotus/configured", params: { sessionId: "agy-session", model: "gemini-3.8-flash", cwd: "/work" } }));
  translator.noteInput(input, "u1");
  emit(translator.translate({ method: "lotus/turnStarted", params: { uuid: "u1" } }));
  if (opts.interrupt) translator.noteInterrupt();
  const lines = readFileSync(path.resolve(__dirname, "../__fixtures__/agy-tool-turn.jsonl"), "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const msg = JSON.parse(line) as { id?: string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
    if (msg.method === "session/request_permission") {
      emit(translator.interactionRequested("i1", translator.permission(msg.params!)));
      emit(translator.interactionResolved("i1", { behavior: "allow" }));
    } else if (msg.result) {
      emit(translator.translate({ method: "lotus/turnEnded", params: { ...msg.result, durationMs: 7000 } }));
    } else {
      emit(translator.translate(msg));
    }
  }
  emit(translator.end(null));
  const events = envelopes.map((e) => e.event);
  const state = applyThreadEvents(emptyThreadState("t"), envelopes);
  return { envelopes, events, rows: buildTimelineRows(state) };
}

const completed = (events: ThreadEvent[]) => events.flatMap((e) => (e.type === "item/completed" ? [e.item] : []));

describe("agy acp transcript → ThreadEvents", () => {
  it("every event matches the wire schema; one turn; every started item completes", () => {
    const { envelopes, events } = replay();
    for (const envelope of envelopes) expect(threadEventEnvelopeSchema.safeParse(envelope).success, JSON.stringify(envelope.event)).toBe(true);
    expect(events.filter((e) => e.type === "turn/started")).toEqual([expect.objectContaining({ turnId: "turn-u1", input })]);
    expect(events.filter((e) => e.type === "turn/completed")).toHaveLength(1);
    const started = events.flatMap((e) => (e.type === "item/started" ? [e.item.id] : []));
    expect(new Set(completed(events).map((i) => i.id))).toEqual(new Set(started));
  });

  it("reports the agy session and its login", () => {
    expect(replay().events[0]).toMatchObject({ type: "session/configured", providerSessionId: "agy-session", authSource: "accountLogin", model: "gemini-3.8-flash" });
  });

  it("shows the read, the command with its output, the Allow, and the answer", () => {
    const { events, rows } = replay();
    const items = completed(events);
    expect(items.find((i) => i.kind === "fileRead")).toMatchObject({ path: "/work/hello.txt", status: "completed" });
    const command = items.find((i) => i.kind === "command");
    expect(command).toMatchObject({ command: "echo hi > bye.txt", description: "Write hi to bye.txt", status: "completed" });
    expect(command?.kind === "command" && command.output).toContain("exited with code 0");
    expect(events.find((e) => e.type === "interaction/requested")).toMatchObject({ interaction: { toolName: "Bash", input: { command: "echo hi > bye.txt" } } });
    const answer = items.find((i) => i.kind === "agentMessage");
    expect(answer?.kind === "agentMessage" && answer.text).toContain("first line here");
    expect(rows.at(-1)).toMatchObject({ kind: "assistant" });
    expect(events.find((e) => e.type === "turn/completed")).toMatchObject({
      status: "completed",
      forkPoint: null,
      usage: { inputTokens: 17_544, outputTokens: 139, durationMs: 7000, contextTokens: 15_541, contextWindow: 1_048_576 },
    });
  });

  it("an interrupted turn says so", () => {
    expect(replay({ interrupt: true }).events.find((e) => e.type === "turn/completed")).toMatchObject({ status: "interrupted" });
  });
});

describe("AcpTranslator.permission", () => {
  it("names a read outside the workspace as Claude's Read, with an Allow-always option remembered", () => {
    const translator = new AcpTranslator();
    const call = { toolCallId: "c\n1", kind: "read", name: "read_file", rawInput: { Path: "/elsewhere/a.txt" } };
    const options = [{ optionId: "a", kind: "allow_always" }];
    expect(translator.permission({ toolCall: call, options })).toEqual({ toolName: "Read", toolUseId: "c-1", input: { file_path: "/elsewhere/a.txt" }, blockedPath: null, remember: true });
  });
});

describe("toolName", () => {
  it("writes agy's MCP tool names the way Claude does, and leaves its own tools alone", () => {
    expect(toolName("mcp_lotus-dev_lotus_chat_list")).toBe("mcp__lotus-dev__lotus_chat_list");
    expect(toolName("read_file")).toBe("read_file");
  });
});
