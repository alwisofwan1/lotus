import { describe, expect, it } from "vitest";

import { applyThreadEvents, emptyThreadState } from "../../../domain/thread-state";
import type { ThreadEvent } from "../../../domain/thread-event";
import { ApiTranslator, ThinkSplitter, httpError, sseData } from "../translate";

const delta = (d: Record<string, string>) => ({ choices: [{ index: 0, delta: d }] });

function turn(chunks: unknown[], error: string | null = null) {
  const t = new ApiTranslator();
  t.noteInput({ text: "Why 5 retries?", clientRequestId: "c1" });
  const events: ThreadEvent[] = [...t.turnStarted("t1", 1000)];
  for (const chunk of chunks) events.push(...t.chunk(chunk));
  const ended = t.turnEnded(error, 3000);
  events.push(...ended.events);
  return { events, answer: ended.answer, translator: t };
}

describe("ApiTranslator", () => {
  it("streams DeepSeek's reasoning, then the answer, with usage", () => {
    const { events, answer } = turn([
      delta({ role: "assistant", reasoning_content: "Cap is 5" }),
      delta({ reasoning_content: " tries." }),
      delta({ content: "Five tries " }),
      delta({ content: "give up at 6 s." }),
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
    ]);
    expect(answer).toBe("Five tries give up at 6 s.");
    const state = applyThreadEvents(
      emptyThreadState("t"),
      events.map((event, i) => ({ threadId: "t", seq: i + 1, at: i, event })),
    );
    expect(state.turns).toHaveLength(1);
    const kinds = events.filter((e) => e.type === "item/completed").map((e) => e.type === "item/completed" && [e.item.kind, "text" in e.item && e.item.text]);
    expect(kinds).toEqual([
      ["reasoning", "Cap is 5 tries."],
      ["agentMessage", "Five tries give up at 6 s."],
    ]);
    expect(events.at(-1)).toEqual({
      type: "turn/completed",
      turnId: "t1",
      status: "completed",
      error: null,
      usage: { inputTokens: 120, outputTokens: 30, costUsd: null, durationMs: 2000 },
      forkPoint: "t1",
    });
  });

  it("reads a leading <think> block as reasoning, split across chunks", () => {
    const { events, answer } = turn([delta({ content: "<thi" }), delta({ content: "nk>hmm</th" }), delta({ content: "ink>\n\nHello" })]);
    expect(answer).toBe("Hello");
    const reasoning = events.filter((e) => e.type === "item/delta").map((e) => e.type === "item/delta" && e.delta);
    expect(reasoning).toEqual(["hmm", "Hello"]);
  });

  it("fails the turn and keeps nothing for the conversation", () => {
    const { events, answer } = turn([], "DeepSeek answered 401: Authentication Fails");
    expect(answer).toBeNull();
    expect(events.at(-1)).toMatchObject({ type: "turn/completed", status: "failed", error: "DeepSeek answered 401: Authentication Fails" });
  });

  it("keeps what an interrupted answer said", () => {
    const t = new ApiTranslator();
    t.turnStarted("t1", 0);
    t.chunk(delta({ content: "Partly" }));
    t.noteInterrupt();
    const { events, answer } = t.turnEnded(null, 10);
    expect(answer).toBe("Partly");
    expect(events.at(-1)).toMatchObject({ status: "interrupted" });
  });
});

describe("ThinkSplitter", () => {
  it("passes plain text straight through", () => {
    const s = new ThinkSplitter();
    expect(s.push("Hi")).toEqual({ reasoning: "", text: "Hi" });
  });

  it("keeps unfinished thinking as thinking when the stream ends", () => {
    const s = new ThinkSplitter();
    expect(s.push("<think>long")).toEqual({ reasoning: "", text: "" });
    expect(s.flush()).toEqual({ reasoning: "long", text: "" });
  });
});

describe("sseData and httpError", () => {
  it("returns complete data lines and keeps the tail", () => {
    expect(sseData('data: {"a":1}\n\n: ping\ndata: [DONE]\ndata: {"b"')).toEqual({ data: ['{"a":1}'], rest: 'data: {"b"' });
  });

  it("names the provider and its message", () => {
    expect(httpError("Sumopod", 401, '{"error":{"message":"invalid api key"}}')).toBe("Sumopod answered 401: invalid api key");
    expect(httpError("Ollama", 404, "model not found")).toBe("Ollama answered 404: model not found");
  });
});
