import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { threadEventEnvelopeSchema, type ThreadEvent, type ThreadItem } from "../../../domain/thread-event";
import { applyThreadEvents, emptyThreadState } from "../../../domain/thread-state";
import { buildTimelineRows, nativeAgents, subAgentState, type TimelineRow } from "../../../domain/timeline";
import { ClaudeTranslator } from "../translate";
import { readFixture, replayFixture, type ReplayOptions } from "./replay-fixture";

// Real Claude Agent SDK transcripts, recorded by scripts/chat-bridge/record-fixtures.ts.

const input = (text: string) => ({ text, clientRequestId: "req-1" });

function run(name: string, options: Partial<ReplayOptions> = {}) {
  const envelopes = replayFixture(name, { inputs: [input(`prompt for ${name}`)], ...options });
  const state = applyThreadEvents(emptyThreadState(`fixture-${name}`), envelopes);
  return { envelopes, events: envelopes.map((e) => e.event), state, rows: buildTimelineRows(state) };
}

const completedItems = (events: ThreadEvent[]): ThreadItem[] =>
  events.flatMap((e) => (e.type === "item/completed" ? [e.item] : []));

const work = (rows: TimelineRow[]) => rows.filter((r): r is Extract<TimelineRow, { kind: "work" }> => r.kind === "work");

describe("Claude transcripts → ThreadEvents", () => {
  it.each(["text-reply", "tool-chain", "tool-denied", "interrupted", "subagent"])("%s: every event matches the wire schema", (name) => {
    for (const envelope of run(name).envelopes) {
      expect(threadEventEnvelopeSchema.safeParse(envelope).success, JSON.stringify(envelope.event)).toBe(true);
    }
  });

  it.each(["text-reply", "tool-chain", "tool-denied", "interrupted", "subagent"])("%s: one turn, every started item completes", (name) => {
    const { events } = run(name);
    expect(events.filter((e) => e.type === "turn/started")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn/completed")).toHaveLength(1);
    const started = events.flatMap((e) => (e.type === "item/started" ? [e.item.id] : []));
    // As a set: an Agent call completes after the steps its sub-agent ran inside it.
    expect(completedItems(events).map((i) => i.id).sort()).toEqual([...started].sort());
    expect(events.at(-1)).toEqual({ type: "session/ended", error: null });
  });

  it.each(["text-reply", "tool-chain", "subagent"])("%s: says the turn is answered once, after its closing reply, never for a sub-agent", (name) => {
    const types = run(name).events.map((e) => e.type);
    expect(types.filter((t) => t === "turn/answered")).toHaveLength(1);
    const answered = types.indexOf("turn/answered");
    expect(answered).toBeLessThan(types.indexOf("turn/completed"));
    // Nothing the agent says or does comes after it.
    expect(types.slice(answered + 1).filter((t) => t === "item/started")).toEqual([]);
  });

  it("records the lead's last chain entry as the fork point, never a sub-agent's, and none for a stopped turn", () => {
    const leadUuids = readFixture("subagent").flatMap((line) => {
      const raw = line.params.event as { type?: string; uuid?: string; parent_tool_use_id?: string | null } | undefined;
      return line.method === "thread/raw" && raw?.type === "assistant" && !raw.parent_tool_use_id && raw.uuid ? [raw.uuid] : [];
    });
    const done = (name: string) => run(name).events.find((e) => e.type === "turn/completed");
    expect(done("subagent")).toMatchObject({ status: "completed", forkPoint: leadUuids.at(-1) });
    expect(leadUuids.length).toBeGreaterThan(0);
    expect(done("interrupted")).toMatchObject({ forkPoint: null });
  });

  it("subagent: the Agent call's own steps nest under it, and only the lead's answer is a reply", () => {
    const { events, rows } = run("subagent");
    const items = completedItems(events);
    const agent = items.find((i) => i.kind === "tool" && i.name === "Agent");
    expect(agent).toMatchObject({ status: "completed", output: expect.stringContaining("2") });
    expect(agent?.parentId).toBeUndefined();
    const commands = items.filter((i) => i.kind === "command");
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((i) => i.parentId === agent?.id)).toBe(true);

    const [card] = work(rows);
    expect(card.summary).toBe("Ran 1 agent");
    expect(card.steps.find((s) => s.item.id === agent?.id)).toMatchObject({ depth: 0, title: expect.stringMatching(/^Ran general-purpose: /) });
    expect(card.steps.filter((s) => s.item.kind === "command").every((s) => s.depth === 1)).toBe(true);
    expect(rows.filter((r) => r.kind === "assistant").map((r) => r.kind === "assistant" && r.text)).toEqual(["notes.txt has 2 lines."]);
  });

  it("subagent: a sub-agent's failed step does not fail the lead's work row", () => {
    const { envelopes } = run("subagent");
    // As seen live: the sub-agent's Read of a missing file failed, it recovered, the row said Failed.
    const failed = envelopes.map((e) =>
      e.event.type === "item/completed" && e.event.item.kind === "command" && e.event.item.parentId
        ? { ...e, event: { ...e.event, item: { ...e.event.item, status: "failed" as const } } }
        : e,
    );
    const [card] = work(buildTimelineRows(applyThreadEvents(emptyThreadState("fixture-subagent"), failed)));
    expect(card.status).toBe("completed");
  });

  it("subagent: lists Claude's own Agent call for the rail, top level, with what it was asked", () => {
    expect(nativeAgents(run("subagent").state)).toEqual([
      { id: expect.any(String), parentId: null, type: "general-purpose", description: expect.any(String), status: "completed" },
    ]);
  });

  it("subagent: its own view is the prompt it got, its steps, and its own reply", () => {
    const { state } = run("subagent");
    const [agent] = nativeAgents(state);
    const watched = subAgentState(state, agent.id);
    const rows = buildTimelineRows(watched!);
    expect(rows.map((r) => r.kind)).toEqual(["user", "work", "assistant"]);
    expect(rows[0].kind === "user" && rows[0].text).toMatch(/notes\.txt/);
    expect(rows[1].kind === "work" && rows[1].steps.every((s) => s.depth === 0)).toBe(true);
    expect(subAgentState(state, "not-an-agent")).toBeNull();
  });

  it("reports the account login as the auth source", () => {
    expect(run("text-reply").state.session).toMatchObject({ authSource: "accountLogin", model: expect.any(String) });
  });

  it("text-reply: streams the answer and matches the final message", () => {
    const { events, state } = run("text-reply");
    const message = completedItems(events).find((i) => i.kind === "agentMessage");
    const streamed = events
      .flatMap((e) => (e.type === "item/delta" && e.itemId === message?.id ? [e.delta] : []))
      .join("");
    expect(message && "text" in message && message.text).toBe(streamed);
    expect(state.turns[0]).toMatchObject({ status: "completed", input: input("prompt for text-reply") });
    expect(state.turns[0].usage?.outputTokens).toBeGreaterThan(0);
  });

  it.each(["tool-chain", "subagent"])("%s: the window gauge is the main agent's last call, not the turn's sum", (name) => {
    const lines = readFileSync(join(__dirname, "../__fixtures__", `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const raw = lines.map((l) => l.params?.event ?? {});
    const last = raw.filter((m) => m.type === "assistant" && !m.parent_tool_use_id && m.message?.usage).at(-1).message.usage;
    const expected = last.input_tokens + (last.cache_creation_input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0);
    const usage = run(name).state.turns.at(-1)?.usage;
    expect(usage?.contextTokens).toBe(expected);
    expect(usage?.contextTokens).toBeLessThan(usage?.inputTokens ?? 0);
    expect(usage?.contextWindow).toBe(1_000_000);
  });

  it("tool-chain: maps each tool to its item kind with its result", () => {
    const tools = completedItems(run("tool-chain").events).filter((i) => i.kind !== "reasoning" && i.kind !== "agentMessage");
    expect(tools.map((i) => i.kind)).toEqual(["fileRead", "command", "fileChange", "fileChange"]);
    expect(tools.every((i) => i.status === "completed")).toBe(true);
    const [read, command, write, edit] = tools;
    expect(read).toMatchObject({ path: expect.stringMatching(/notes\.txt$/), lineCount: 4 });
    expect(command).toMatchObject({ command: expect.stringContaining("wc -l"), output: expect.stringContaining("3") });
    expect(write).toMatchObject({ change: "create", path: expect.stringMatching(/summary\.md$/) });
    expect(write.kind === "fileChange" && write.patch?.[0].lines.every((l) => l.startsWith("+"))).toBe(true);
    expect(edit).toMatchObject({ change: "edit" });
    expect(edit.kind === "fileChange" && edit.patch?.[0].lines).toContain("+Lotus grows in mud");
  });

  it("tool-chain: one work row between the prompt and the answer, approvals attached", () => {
    const { rows } = run("tool-chain");
    expect(rows.map((r) => r.kind)).toEqual(["user", "work", "assistant"]);
    const [group] = work(rows);
    expect(group.summary).toBe("Read 1 file, ran 1 command, created 1 file, edited 1 file");
    expect(group.status).toBe("completed");
    expect(group.steps.map((s) => s.title)).toEqual([
      "Read notes.txt",
      "Ran wc -l notes.txt",
      "Created summary.md",
      "Edited notes.txt",
    ]);
    expect(group.steps.map((s) => s.interaction?.resolution?.decision ?? null)).toEqual([null, null, "allowed", "allowed"]);
  });

  it("tool-denied: the refused command is declined, not failed", () => {
    const { events, rows } = run("tool-denied", {
      decide: (tool) => (tool === "Bash" ? { behavior: "deny", message: "The user declined this command." } : { behavior: "allow" }),
    });
    const command = completedItems(events).find((i) => i.kind === "command");
    expect(command).toMatchObject({ status: "declined", command: "rm -rf build" });
    const [group] = work(rows);
    expect(group.summary).toBe("Declined 1 step");
    expect(group.steps[0].interaction?.resolution).toMatchObject({ decision: "denied" });
    expect(rows.at(-1)?.kind).toBe("assistant");
  });

  it("interrupted: the SDK says success, the turn says interrupted", () => {
    const { state, rows } = run("interrupted");
    expect(state.turns[0].status).toBe("interrupted");
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "notice"]);
    expect(rows.at(-1)).toMatchObject({ tone: "warning", text: "Stopped." });
  });

  it("a turn with no queued input still starts", () => {
    const { state, rows } = run("text-reply", { inputs: [] });
    expect(state.turns[0].input).toBeNull();
    expect(rows[0].kind).toBe("assistant");
  });

  it("replaying the same events twice changes nothing", () => {
    const { envelopes, state } = run("tool-chain");
    expect(applyThreadEvents(state, envelopes)).toBe(state);
  });
});

describe("ClaudeTranslator edge cases", () => {
  const newTranslator = () => {
    let n = 0;
    return new ClaudeTranslator({ newId: () => `id-${++n}` });
  };

  it("builds items from `assistant` messages when there are no stream events", () => {
    const t = newTranslator();
    const events = t.translate({
      type: "assistant",
      message: { id: "m1", content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/a.txt" } }] },
    });
    expect(events.map((e) => e.type)).toEqual(["turn/started", "item/started", "item/completed", "item/started"]);
    expect(events[2]).toMatchObject({ item: { kind: "agentMessage", text: "hello", status: "completed" } });
    expect(events[3]).toMatchObject({ item: { id: "tu1", kind: "fileRead", path: "/a.txt", status: "running" } });
  });

  it("closes running items as interrupted when the stream ends mid-turn", () => {
    const t = newTranslator();
    t.translate({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 99" } }] } });
    const events = t.end("claude exited");
    expect(events).toEqual([
      expect.objectContaining({ type: "item/completed", item: expect.objectContaining({ id: "tu1", status: "interrupted" }) }),
      expect.objectContaining({ type: "turn/completed", status: "failed", error: "claude exited" }),
      { type: "session/ended", error: "claude exited" },
    ]);
  });

  it("a background Agent call stays running after it launches, until its task_notification", () => {
    const t = newTranslator();
    t.translate({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "ag1", name: "Agent", input: { description: "Sum docs", prompt: "p", run_in_background: true } }] } });
    const launched = t.translate({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "ag1", content: "Async agent launched" }] },
      tool_use_result: { isAsync: true, status: "async_launched" },
    });
    expect(launched).toEqual([expect.objectContaining({ type: "item/completed", item: expect.objectContaining({ id: "ag1", status: "running" }) })]);
    const turnId = (launched[0] as { turnId: string }).turnId;
    t.translate({ type: "result", subtype: "success" });
    const ended = t.translate({ type: "system", subtype: "task_notification", tool_use_id: "ag1", status: "completed", summary: "done" });
    expect(ended).toEqual([{ type: "item/completed", turnId, item: expect.objectContaining({ id: "ag1", status: "completed", output: "done" }) }]);
    expect(t.translate({ type: "system", subtype: "task_notification", tool_use_id: "ag1", status: "completed", summary: "x" })).toEqual([]);
  });

  it("background_tasks_changed reports how many background tasks still run", () => {
    const t = newTranslator();
    const tasks = [{ task_id: "b1", task_type: "local_bash" }];
    expect(t.translate({ type: "system", subtype: "background_tasks_changed", tasks })).toEqual([{ type: "session/background", running: 1 }]);
    expect(t.translate({ type: "system", subtype: "background_tasks_changed", tasks: [] })).toEqual([{ type: "session/background", running: 0 }]);
    expect(t.translate({ type: "system", subtype: "background_tasks_changed" })).toEqual([]);
  });

  it("a background agent still running when its session ends reads interrupted", () => {
    const t = newTranslator();
    const events = [
      ...t.translate({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "ag1", name: "Agent", input: { prompt: "p", run_in_background: true } }] } }),
      ...t.translate({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ag1", content: "launched" }] }, tool_use_result: { status: "async_launched" } }),
      ...t.translate({ type: "result", subtype: "success" }),
      ...t.end(null),
    ];
    const state = applyThreadEvents(emptyThreadState("t"), events.map((event, i) => ({ threadId: "t", seq: i + 1, at: i, event })));
    expect(nativeAgents(state)[0].status).toBe("interrupted");
  });

  it("fails a message the CLI never took in when the stream ends, instead of dropping it", () => {
    const t = newTranslator();
    t.noteInput({ text: "long first prompt", clientRequestId: "c1" }, "u1");
    const events = t.end(null);
    expect(events).toEqual([
      expect.objectContaining({ type: "turn/started", input: { text: "long first prompt", clientRequestId: "c1" } }),
      expect.objectContaining({ type: "turn/completed", status: "failed", error: expect.stringContaining("Send it again") }),
      { type: "session/ended", error: null },
    ]);
  });

  it("reports an error result as a failed turn with the error text", () => {
    const t = newTranslator();
    const events = t.translate({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] });
    expect(events.at(-1)).toMatchObject({ type: "turn/completed", status: "failed", error: "boom" });
  });

  it("an API key login is reported as apiKey", () => {
    const [event] = newTranslator().translate({ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY", session_id: "s" });
    expect(event).toMatchObject({ type: "session/configured", authSource: "apiKey", providerSessionId: "s" });
  });

  it("reports a permission mode change Claude makes itself (ExitPlanMode → default)", () => {
    const t = newTranslator();
    const init = t.translate({ type: "system", subtype: "init", permissionMode: "plan", session_id: "s" });
    expect(init.some((e) => e.type === "session/permissionChanged")).toBe(false);
    expect(t.translate({ type: "system", subtype: "status", permissionMode: "plan" })).toEqual([]);
    expect(t.translate({ type: "system", subtype: "status", permissionMode: "default" })).toEqual([
      { type: "session/permissionChanged", mode: "default", label: "Ask before edits" },
    ]);
  });

  it("cuts very long tool output", () => {
    const t = newTranslator();
    t.translate({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "yes" } }] } });
    const events = t.translate({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "y\n".repeat(40_000) + "Tests  1 failed | 18 passed (19)" }] },
    });
    const item = events[0].type === "item/completed" ? events[0].item : null;
    expect(item?.kind === "command" && item.output?.length).toBeLessThan(33_000);
    // The middle goes; the end, where runners print their counts, stays.
    expect(item?.kind === "command" && item.output).toMatch(/more characters\] …\n[\s\S]*Tests {2}1 failed \| 18 passed \(19\)$/);
  });
});

describe("ClaudeTranslator input echoes (replay-user-messages)", () => {
  const echo = (uuid: string, text: string) => ({ type: "user", isReplay: true, uuid, message: { role: "user", content: text }, parent_tool_use_id: null });
  const result = { type: "result", subtype: "success", is_error: false, result: "STEERED" };

  it("a steer taken in mid-turn stays in that turn, and the next turn gets its own input", () => {
    let n = 0;
    const t = new ClaudeTranslator({ newId: () => `id-${++n}` });
    t.noteInput({ text: "run five steps", clientRequestId: "base" }, "u-base");
    const events = [...t.translate(echo("u-base", "run five steps"))];
    t.noteInput({ text: "stop", clientRequestId: "steer" }, "u-steer");
    events.push(...t.translate(echo("u-steer", "stop")), ...t.translate(result));
    t.noteInput({ text: "again", clientRequestId: "after" }, "u-after");
    events.push(...t.translate(echo("u-after", "again")));

    const started = events.flatMap((e) => (e.type === "turn/started" ? [e.input?.clientRequestId] : []));
    expect(started).toEqual(["base", "after"]);
    const rows = buildTimelineRows(applyThreadEvents(emptyThreadState("t"), events.map((event, i) => ({ threadId: "t", seq: i + 1, at: i, event }))));
    expect(rows.filter((r) => r.kind === "user").map((r) => (r as { text: string }).text)).toEqual(["run five steps", "stop", "again"]);
  });

  it("a turn opened before its echo does not show the input twice", () => {
    const t = new ClaudeTranslator({ newId: () => "turn" });
    t.noteInput({ text: "hi", clientRequestId: "a" }, "u-a");
    const events = [...t.translate({ type: "stream_event", event: { type: "message_start", message: { id: "m" } } }), ...t.translate(echo("u-a", "hi"))];
    expect(events.map((e) => e.type)).toEqual(["turn/started"]);
  });

  // Seen live 2026-11-02 in a folder with SessionStart hooks: the turn opened with input null, so
  // the chat stayed "Untitled chat" and the message came in late as a mid-turn item.
  it("an echo Lotus did not send opens the turn with our input, and our echo adds nothing", () => {
    const t = new ClaudeTranslator({ newId: () => "turn" });
    t.noteInput({ text: "hi", clientRequestId: "a" }, "u-a");
    const events = [...t.translate(echo("u-hook", "hook context")), ...t.translate(echo("u-a", "hi"))];
    expect(events).toEqual([{ type: "turn/started", turnId: "turn", input: { text: "hi", clientRequestId: "a" } }]);
  });
});

describe("ClaudeTranslator AskUserQuestion", () => {
  // The input shape the CLI sent in the live spike (scripts/chat-bridge/question-spike.ts).
  const ask = {
    toolName: "AskUserQuestion",
    toolUseId: "tu-1",
    blockedPath: null,
    input: {
      questions: [
        {
          question: "Which colour do you prefer?",
          header: "Colour",
          options: [{ label: "Red", description: "The colour red." }, { label: "Blue" }],
          multiSelect: false,
        },
      ],
    },
  };

  it("asks a question instead of a tool permission, and records the answers", () => {
    const t = new ClaudeTranslator();
    const [requested] = t.interactionRequested("i1", ask);
    expect(requested).toMatchObject({
      type: "interaction/requested",
      interaction: {
        kind: "question",
        itemId: "tu-1",
        questions: [
          {
            question: "Which colour do you prefer?",
            header: "Colour",
            options: [
              { label: "Red", description: "The colour red." },
              { label: "Blue", description: null },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    const answers = { "Which colour do you prefer?": "Blue" };
    expect(t.interactionResolved("i1", { behavior: "allow", answers })).toEqual([
      { type: "interaction/resolved", interactionId: "i1", decision: "answered", message: null, answers },
    ]);
  });

  it("an input the schema cannot read stays a tool permission", () => {
    const [requested] = new ClaudeTranslator().interactionRequested("i1", { ...ask, input: { questions: "?" } });
    expect(requested).toMatchObject({ interaction: { kind: "toolPermission", toolName: "AskUserQuestion" } });
  });
});
