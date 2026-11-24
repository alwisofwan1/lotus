import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TranscriptEntry, TranscriptResponse } from "../../../../types/transcript.js";
import { FIXTURES } from "../../__tests__/support/fixtures.js";
import { turnsFromEntries } from "../parts-from-entries.js";

const at = 1_785_664_800_000;
const entry = (over: Partial<TranscriptEntry>): TranscriptEntry => ({
  event: "tool-pre", status: "running", title: "", body: "", userPrompt: "", toolTarget: "", timestamp: at, ...over,
});

describe("turnsFromEntries", () => {
  it("renders the committed transcript fixture as one turn: prompt, edit with diffstat, read, reply", () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "rest-transcript.json"), "utf8")) as TranscriptResponse;
    const turns = turnsFromEntries(fixture.entries, "hook");

    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn?.stopReason).toBe("end_turn");
    expect(turn?.parts.map((p) => p.type)).toEqual(["user_message", "tool_call", "tool_call", "assistant_text"]);
    const [prompt, edit, read, reply] = turn?.parts ?? [];
    expect(prompt).toMatchObject({ type: "user_message", text: "clean up the legacy files" });
    // A `tool-post` with no `tool-pre` before it — the ring evicted it — is still a step.
    expect(edit).toMatchObject({
      type: "tool_call", toolName: "Edit", kind: "edit", status: "completed", title: "src/legacy/shim.ts",
      locations: [{ path: "src/legacy/shim.ts" }],
      diff: { files: [{ path: "src/legacy/shim.ts", op: "modify", additions: 0, deletions: 34 }] },
    });
    // A Read carries no diff at all — absent, not zero — and is still open at page end.
    expect(read).toMatchObject({ type: "tool_call", toolName: "Read", kind: "read", status: "in_progress" });
    expect(read).not.toHaveProperty("diff");
    expect(reply).toMatchObject({ type: "assistant_text", state: "done", truncated: true });
  });

  it("pairs a tool-pre with the tool-post that follows it into one completed call", () => {
    const turns = turnsFromEntries([
      entry({ event: "prompt-submit", title: "You", body: "run it", timestamp: at }),
      entry({ event: "tool-pre", title: "Bash", toolTarget: "npm test", timestamp: at + 1 }),
      entry({ event: "tool-pre", title: "Read", toolTarget: "a.ts", timestamp: at + 2 }),
      entry({ event: "tool-post", title: "Read", toolTarget: "a.ts", timestamp: at + 3 }),
      entry({ event: "tool-post-failed", title: "Bash", toolTarget: "npm test", timestamp: at + 4 }),
    ], "derived");

    const calls = turns[0]?.parts.filter((p) => p.type === "tool_call") ?? [];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ toolName: "Bash", kind: "execute", status: "failed", locations: [] });
    expect(calls[1]).toMatchObject({ toolName: "Read", status: "completed" });
    expect(calls.every((c) => c.provenance === "derived")).toBe(true);
  });

  it("a result that names no tool completes the last open call", () => {
    // `transcript_source.rs` writes Codex outputs as `tool-post` with an empty title.
    const turns = turnsFromEntries([
      entry({ event: "tool-pre", title: "exec", toolTarget: "ls", timestamp: at }),
      entry({ event: "tool-post", title: "Tool", timestamp: at + 1 }),
    ], "derived");
    expect(turns[0]?.parts).toHaveLength(1);
    expect(turns[0]?.parts[0]).toMatchObject({ type: "tool_call", toolName: "exec", status: "completed" });
  });

  it("opens a new turn on prompt-submit, and on a repeated prompt after a stop", () => {
    const turns = turnsFromEntries([
      entry({ event: "prompt-submit", title: "You", body: "run the tests", timestamp: at }),
      entry({ event: "stop", body: "Done.", userPrompt: "run the tests", timestamp: at + 1 }),
      // The same sentence again, from a host that sends no `prompt-submit`.
      entry({ event: "tool-pre", title: "Bash", toolTarget: "npm test", userPrompt: "run the tests", timestamp: at + 2 }),
      entry({ event: "stop", body: "Still green.", userPrompt: "run the tests", timestamp: at + 3 }),
    ], "hook");

    expect(turns).toHaveLength(2);
    expect(turns[0]?.endedAt).toBe(at + 1);
    expect(turns[1]?.parts.map((p) => p.type)).toEqual(["user_message", "tool_call", "assistant_text"]);
    expect(turns[1]?.startedAt).toBe(at + 2);
  });

  it("a userPrompt that differs from the submitted prompt does not open a phantom turn", () => {
    // The two fields are clipped at different caps; only a `stop` ends a submitted turn.
    const turns = turnsFromEntries([
      entry({ event: "prompt-submit", body: "a very long prompt, in full", timestamp: at }),
      entry({ event: "tool-pre", title: "Read", toolTarget: "a.ts", userPrompt: "a very long prompt, in", timestamp: at + 1 }),
      entry({ event: "stop", body: "Done.", userPrompt: "a very long prompt, in", timestamp: at + 2 }),
    ], "hook");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.parts.map((p) => p.type)).toEqual(["user_message", "tool_call", "assistant_text"]);
  });

  it("a stop with nothing to say still closes the turn without an empty text part", () => {
    const turns = turnsFromEntries([
      entry({ event: "prompt-submit", body: "go", timestamp: at }),
      entry({ event: "stop", body: "", timestamp: at + 1 }),
    ], "hook");
    expect(turns[0]?.parts.map((p) => p.type)).toEqual(["user_message"]);
    expect(turns[0]?.stopReason).toBe("end_turn");
  });

  it("an interruption is an error part that closes the turn as cancelled", () => {
    const turns = turnsFromEntries([
      entry({ event: "prompt-submit", body: "go", timestamp: at }),
      entry({ event: "error", status: "error", title: "Interrupted", toolTarget: "interrupted", timestamp: at + 1 }),
    ], "derived");
    expect(turns[0]?.parts[1]).toMatchObject({ type: "error", message: "interrupted", recoverable: false });
    expect(turns[0]?.stopReason).toBe("cancelled");
  });

  it("a needs-input notification is a requires_action status carrying the question", () => {
    const turns = turnsFromEntries([
      entry({ event: "notification", status: "needs-input", title: "Bash", body: "Do you want to run this command?", userPrompt: "clean up", timestamp: at }),
    ], "hook");
    expect(turns[0]?.parts.at(-1)).toMatchObject({ type: "status", state: "requires_action", detail: "Do you want to run this command?" });
  });

  it("an event this host has never seen but that names a tool is a step of kind other, not dropped", () => {
    const turns = turnsFromEntries([
      entry({ event: "subagent-start", title: "Explore", toolTarget: "map the repo", userPrompt: "go", timestamp: at }),
    ], "hook");
    expect(turns[0]?.parts.at(-1)).toMatchObject({ type: "tool_call", toolName: "Explore", title: "map the repo", kind: "other", status: "completed" });
  });

  it("an unnamed event with a body is kept as an unknown part, not dropped", () => {
    const turns = turnsFromEntries([
      entry({ event: "compact", body: "context compacted", userPrompt: "go", timestamp: at }),
    ], "hook");
    expect(turns[0]?.parts.at(-1)).toMatchObject({ type: "unknown", rawType: "compact", summary: "context compacted" });
  });

  it("a bare prompt carrier — no title, no target, no body — draws nothing beyond the turn's prompt", () => {
    const turns = turnsFromEntries([
      entry({ event: "user", userPrompt: "clean up", timestamp: at }),
    ], "hook");
    expect(turns[0]?.parts.map((p) => p.type)).toEqual(["user_message"]);
  });

  it("ids are stable across calls and distinct for entries in the same millisecond", () => {
    const a = entry({ event: "tool-pre", title: "Read", toolTarget: "a.ts", userPrompt: "x", timestamp: at });
    const b = entry({ event: "tool-pre", title: "Read", toolTarget: "b.ts", userPrompt: "x", timestamp: at });
    const first = turnsFromEntries([a, b], "hook");
    const again = turnsFromEntries([a, b], "hook");
    const ids = (t: typeof first) => t[0]?.parts.map((p) => p.id) ?? [];
    expect(ids(first)).toEqual(ids(again));
    expect(new Set(ids(first)).size).toBe(3);
  });
});

/**
 * A question is its own part, never a `tool_call` whose title happens to be a sentence. The
 * options and their descriptions have nowhere to live on a call, and a client that had to
 * re-parse a title into buttons would draw them wrong.
 */
describe("an AskUserQuestion step", () => {
  const asking = {
    ...entry({ event: "tool-pre", title: "AskUserQuestion", toolTarget: "Tabs or spaces?" }),
    questions: [
      {
        question: "Tabs or spaces?",
        header: "Indentation",
        options: [
          { label: "Spaces", description: "Indent with spaces." },
          { label: "Tabs" },
        ],
      },
    ],
  };

  it("becomes a question part carrying every option and its words", () => {
    const parts = turnsFromEntries([asking], "hook").flatMap((t) => t.parts);
    const question = parts.find((p) => p.type === "question");

    expect(question).toMatchObject({
      type: "question",
      questions: [
        {
          question: "Tabs or spaces?",
          header: "Indentation",
          options: [{ label: "Spaces", description: "Indent with spaces." }, { label: "Tabs" }],
        },
      ],
    });
  });

  it("draws no tool call beside it — one step, one part", () => {
    const parts = turnsFromEntries([asking], "hook").flatMap((t) => t.parts);

    expect(parts.filter((p) => p.type === "tool_call")).toHaveLength(0);
  });

  it("leaves a tool-pre without questions as the call it has always been", () => {
    const parts = turnsFromEntries(
      [entry({ event: "tool-pre", title: "Bash", toolTarget: "ls -la" })],
      "hook",
    ).flatMap((t) => t.parts);

    expect(parts.filter((p) => p.type === "tool_call")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "question")).toHaveLength(0);
  });
});

/**
 * **A question with an end.** Until 2026-09-09 it had none: the card the phone drew stayed on
 * screen whatever the operator did at the keyboard, because the result answering it was paired
 * by tool **name** and a question part has no name to pair with. `bb` gives every interaction a
 * resolution and a `resolvedAt` (`domain/pending-interactions.ts`); this is the same idea read
 * off the runner's own file.
 */
describe("what became of a question", () => {
  const asked = {
    ...entry({ event: "tool-pre", title: "AskUserQuestion", toolTarget: "Tabs or spaces?" }),
    toolCallId: "toolu_9",
    questions: [{ question: "Tabs or spaces?", options: [{ label: "Spaces" }, { label: "Tabs" }] }],
  };

  it("closes with what the operator chose", () => {
    const parts = turnsFromEntries([
      asked,
      { ...entry({ event: "tool-post", timestamp: at + 1 }), toolCallId: "toolu_9", answers: { "Tabs or spaces?": ["Tabs"] } },
    ], "hook").flatMap((t) => t.parts);

    expect(parts.filter((p) => p.type === "question")).toHaveLength(1);
    expect(parts.find((p) => p.type === "question")).toMatchObject({
      answered: { "Tabs or spaces?": ["Tabs"] },
    });
  });

  /// Esc at the desktop. The phone must stop asking — that is the whole bug.
  it("closes as cancelled when the operator refused it", () => {
    const parts = turnsFromEntries([
      asked,
      { ...entry({ event: "tool-post-failed", timestamp: at + 1 }), toolCallId: "toolu_9" },
    ], "hook").flatMap((t) => t.parts);

    const question = parts.find((p) => p.type === "question");
    expect(question).toMatchObject({ cancelled: true });
    expect(question?.type === "question" ? question.answered : "x").toBeUndefined();
  });

  it("stays open while nothing has answered it", () => {
    const parts = turnsFromEntries([asked], "hook").flatMap((t) => t.parts);
    const question = parts.find((p) => p.type === "question");

    expect(question?.type === "question" ? question.answered : "x").toBeUndefined();
    expect(question?.type === "question" ? question.cancelled : "x").toBeUndefined();
  });

  /**
   * The id is the point: two calls of the same tool used to be paired by name, so a result
   * could settle the wrong one. A name cannot tell them apart; an id can.
   */
  it("pairs a result with the call that carries its id, not with whichever came last", () => {
    const parts = turnsFromEntries([
      { ...entry({ event: "tool-pre", title: "Bash", toolTarget: "sleep 30" }), toolCallId: "a" },
      { ...entry({ event: "tool-pre", title: "Bash", toolTarget: "ls" }), toolCallId: "b" },
      { ...entry({ event: "tool-post", title: "Bash", timestamp: at + 1 }), toolCallId: "a" },
    ], "hook").flatMap((t) => t.parts);

    const calls = parts.filter((p) => p.type === "tool_call");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.type === "tool_call" ? [c.title, c.status] : [])).toEqual([
      ["sleep 30", "completed"],
      ["ls", "in_progress"],
    ]);
  });
});

