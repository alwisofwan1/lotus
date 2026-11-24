import { describe, expect, it } from "vitest";

import type { Interaction, ThreadEvent } from "../thread-event";
import { applyThreadEvents, emptyThreadState } from "../thread-state";
import { decisionRecord, optionLabel, requestDetail, requestTitle, splitQuestion, waitingRequests } from "../requests";

type Permission = Extract<Interaction, { kind: "toolPermission" }>;

const bash = (id: string): Permission => ({
  id,
  kind: "toolPermission",
  itemId: null,
  toolName: "Bash",
  input: { command: "npm test -- parser", description: "Run the parser tests" },
  blockedPath: null,
});

function state(events: ThreadEvent[]) {
  return applyThreadEvents(
    emptyThreadState("t"),
    events.map((event, i) => ({ threadId: "t", seq: i + 1, at: i, event })),
  );
}

const started: ThreadEvent = { type: "turn/started", turnId: "turn", input: null };
const requested = (interaction: Interaction): ThreadEvent => ({ type: "interaction/requested", turnId: "turn", interaction });

describe("waitingRequests", () => {
  it("lists unresolved requests of the running turn, oldest first", () => {
    const s = state([
      started,
      requested(bash("a")),
      requested(bash("b")),
      requested(bash("c")),
      { type: "interaction/resolved", interactionId: "b", decision: "allowed", message: null, answers: null },
    ]);
    expect(waitingRequests(s).map((r) => r.interaction.id)).toEqual(["a", "c"]);
  });

  it("drops requests once their turn ends or the session ends", () => {
    const ended: ThreadEvent = { type: "turn/completed", turnId: "turn", status: "interrupted", error: null, usage: null };
    expect(waitingRequests(state([started, requested(bash("a")), ended]))).toEqual([]);
    expect(waitingRequests(state([started, requested(bash("a")), { type: "session/ended", error: null }]))).toEqual([]);
  });
});

describe("requestTitle and requestDetail", () => {
  it("names a command and shows it with Claude's reason", () => {
    expect(requestTitle(bash("a"))).toBe("Run a command?");
    expect(requestDetail(bash("a"), null)).toEqual({ target: "npm test -- parser", lines: [], note: "Run the parser tests" });
  });

  it("shows an edit as the change, with the path relative to the folder", () => {
    const edit: Permission = {
      ...bash("e"),
      toolName: "Edit",
      input: { file_path: "/w/lotus/src/parser.ts", old_string: "if (a == null)", new_string: "if (a === undefined)" },
    };
    expect(requestTitle(edit)).toBe("Edit a file?");
    expect(requestDetail(edit, "/w/lotus")).toEqual({
      target: "src/parser.ts",
      lines: [
        { sign: "-", text: "if (a == null)" },
        { sign: "+", text: "if (a === undefined)" },
      ],
      note: null,
    });
  });

  it("shows a Codex edit from its unified diff", () => {
    const edit: Permission = {
      ...bash("e"),
      toolName: "Edit",
      input: { file_path: "/w/lotus/a.ts", diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n" },
    };
    expect(requestDetail(edit, "/w/lotus").lines).toEqual([
      { sign: " ", text: "keep" },
      { sign: "-", text: "old" },
      { sign: "+", text: "new" },
    ]);
  });

  it("says when a write is outside the folder", () => {
    const write: Permission = {
      ...bash("w"),
      toolName: "Write",
      input: { file_path: "/Users/a/.zshrc", content: "export A=1\nexport B=2\n" },
      blockedPath: "/Users/a/.zshrc",
    };
    expect(requestTitle(write)).toBe("Create a file outside the folder?");
    expect(requestDetail(write, "/w/lotus")).toMatchObject({ target: "/Users/a/.zshrc · 2 lines" });
  });

  it("falls back to the tool name and its input", () => {
    const other: Permission = { ...bash("x"), toolName: "mcp__lotus__spawn", input: { name: "cell" } };
    expect(requestTitle(other)).toBe("Use mcp__lotus__spawn?");
    expect(requestDetail(other, null)).toEqual({ target: '{"name":"cell"}', lines: [], note: null });
  });
});

describe("decisionRecord", () => {
  const question: Interaction = {
    id: "q",
    kind: "question",
    itemId: null,
    questions: [{ question: "Which library?", header: "Library", options: [], multiSelect: false }],
  };
  const at = 1;

  it("keeps the note of a denial and the answer of a question", () => {
    expect(decisionRecord(bash("a"), { decision: "allowed", message: null, answers: null, at })).toBe("Allowed");
    expect(decisionRecord(bash("a"), { decision: "denied", message: "Keep == null", answers: null, at })).toBe("Denied — “Keep == null”");
    expect(decisionRecord(question, { decision: "answered", message: null, answers: { "Which library?": "date-fns" }, at })).toBe(
      "Answered Library · date-fns",
    );
  });

  it("does not quote the default messages", () => {
    expect(decisionRecord(bash("a"), { decision: "denied", message: "The user denied this.", answers: null, at })).toBe("Denied");
    expect(decisionRecord(question, { decision: "denied", message: "The user skipped the question.", answers: null, at })).toBe(
      "Skipped",
    );
  });
});

describe("splitQuestion", () => {
  const changes = [
    { key: "Status", from: "Not started", to: "In progress" },
    { key: "Estimates", from: "(empty)", to: "2" },
    { key: "Repos", from: null, to: "no change (it already says Backend + Frontend)" },
  ];

  it("splits a newline list into the ask, the changes and the text after", () => {
    const text =
      "Can I set these on TKT-1142?\n• Status: Not started → In progress\n• Estimates: (empty) → 2\n" +
      "• Repos: no change (it already says Backend + Frontend)\n\nI pick 2 because it is half a day.";
    expect(splitQuestion(text)).toEqual({ ask: "Can I set these on TKT-1142?", changes, rest: "I pick 2 because it is half a day." });
  });

  it("splits an inline • list", () => {
    const text = "Can I set these? • Status: Not started → In progress • Estimates: (empty) → 2 • Repos: no change (it already says Backend + Frontend)";
    expect(splitQuestion(text)).toEqual({ ask: "Can I set these?", changes, rest: "" });
  });

  it("keeps text without a change list whole", () => {
    const text = "Which one?\nA plain line\n- Status: A → B";
    expect(splitQuestion(text)).toEqual({ ask: text, changes: [], rest: "" });
    expect(splitQuestion("Go A → B?")).toEqual({ ask: "Go A → B?", changes: [], rest: "" });
  });
});

describe("optionLabel", () => {
  it("moves (Recommended) into a flag", () => {
    expect(optionLabel("Yes, set all (Recommended)")).toEqual({ label: "Yes, set all", recommended: true });
    expect(optionLabel("No")).toEqual({ label: "No", recommended: false });
  });
});
