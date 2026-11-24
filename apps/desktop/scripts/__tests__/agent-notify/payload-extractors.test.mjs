import { describe, it, expect } from "vitest";
import {
  extractBody,
  extractSessionId,
  extractToolDiffStat,
  extractToolName,
  extractToolTarget,
  extractTranscriptPath,
  extractUserPrompt,
  looksLikeToolFailure,
  parseJsonSafe,
} from "../../agent-notify/payload-extractors.mjs";

describe("parseJsonSafe", () => {
  it("returns parsed object on valid JSON", () => {
    expect(parseJsonSafe('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null on invalid JSON", () => {
    expect(parseJsonSafe("not json")).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(parseJsonSafe("")).toBeNull();
  });

  it("returns null on non-string input", () => {
    expect(parseJsonSafe(null)).toBeNull();
    expect(parseJsonSafe(undefined)).toBeNull();
    expect(parseJsonSafe(123)).toBeNull();
  });
});

describe("extractSessionId", () => {
  it("returns null for null/non-object payload", () => {
    expect(extractSessionId(null)).toBeNull();
    expect(extractSessionId(undefined)).toBeNull();
    expect(extractSessionId("string")).toBeNull();
  });

  it("reads top-level session_id (Claude shape)", () => {
    expect(extractSessionId({ session_id: "abc-123" })).toBe("abc-123");
  });

  it("reads top-level sessionId (camelCase)", () => {
    expect(extractSessionId({ sessionId: "xyz" })).toBe("xyz");
  });

  it("reads nested session.id (Codex shape)", () => {
    expect(extractSessionId({ session: { id: "sess-9" } })).toBe("sess-9");
  });

  it("prefers top-level session_id over nested session.id", () => {
    expect(
      extractSessionId({ session_id: "top", session: { id: "nested" } }),
    ).toBe("top");
  });

  it("ignores non-string session id values", () => {
    expect(extractSessionId({ session_id: 123 })).toBeNull();
    expect(extractSessionId({ session: { id: null } })).toBeNull();
  });

  it("ignores empty session_id strings", () => {
    expect(extractSessionId({ session_id: "" })).toBeNull();
  });
});

describe("extractBody", () => {
  it("returns empty string for non-object payload", () => {
    expect(extractBody(null)).toBe("");
  });

  it("reads last_assistant_message (Claude)", () => {
    expect(extractBody({ last_assistant_message: "Done." })).toBe("Done.");
  });

  it("reads camelCase lastAssistantMessage", () => {
    expect(extractBody({ lastAssistantMessage: "Done." })).toBe("Done.");
  });

  it("falls through to message, body, text in order", () => {
    expect(extractBody({ message: "m" })).toBe("m");
    expect(extractBody({ body: "b" })).toBe("b");
    expect(extractBody({ text: "t" })).toBe("t");
  });

  it("trims whitespace", () => {
    expect(extractBody({ body: "  hello  " })).toBe("hello");
  });

  it("ignores empty/whitespace-only strings", () => {
    expect(extractBody({ body: "   " })).toBe("");
  });

  it("prefers last_assistant_message over message", () => {
    expect(
      extractBody({ last_assistant_message: "primary", message: "fallback" }),
    ).toBe("primary");
  });
});

describe("extractUserPrompt", () => {
  it("returns empty string for non-object payload", () => {
    expect(extractUserPrompt(null)).toBe("");
  });

  it("reads top-level prompt (Claude)", () => {
    expect(extractUserPrompt({ prompt: "do thing" })).toBe("do thing");
  });

  it("reads user_prompt and userPrompt", () => {
    expect(extractUserPrompt({ user_prompt: "x" })).toBe("x");
    expect(extractUserPrompt({ userPrompt: "y" })).toBe("y");
  });

  it("does NOT read body/message/text fields (those are body, not prompt)", () => {
    expect(extractUserPrompt({ body: "b", message: "m" })).toBe("");
    expect(extractUserPrompt({ last_assistant_message: "lam" })).toBe("");
  });

  it("walks input_messages array from end (Codex agent-turn-complete)", () => {
    expect(
      extractUserPrompt({
        input_messages: [
          { content: "first" },
          { content: "second" },
          { content: "last user msg" },
        ],
      }),
    ).toBe("last user msg");
  });

  it("handles input_messages with string entries", () => {
    expect(extractUserPrompt({ input_messages: ["a", "b", "c"] })).toBe("c");
  });

  it("skips empty entries when walking input_messages", () => {
    expect(
      extractUserPrompt({
        input_messages: ["valid", "", null, undefined, "  "],
      }),
    ).toBe("valid");
  });

  it("recurses into nested params (Cursor shape)", () => {
    expect(
      extractUserPrompt({ params: { userPrompt: "Refactor auth" } }),
    ).toBe("Refactor auth");
  });

  it("trims and ignores blank prompts", () => {
    expect(extractUserPrompt({ prompt: "   " })).toBe("");
    expect(extractUserPrompt({ prompt: "  hi  " })).toBe("hi");
  });

  it("returns empty string when nothing matches", () => {
    expect(extractUserPrompt({ unrelated: "x" })).toBe("");
  });
});

describe("extractToolName", () => {
  it("reads the tool name from a Claude Code tool hook payload", () => {
    expect(extractToolName({ tool_name: "Edit", tool_input: { file_path: "/a.ts" } })).toBe("Edit");
  });

  it("accepts the camelCase spelling other CLIs use", () => {
    expect(extractToolName({ toolName: "Bash" })).toBe("Bash");
  });

  it("returns empty for a payload with no tool — a Stop hook must not inherit a stale title", () => {
    expect(extractToolName({ session_id: "s1" })).toBe("");
    expect(extractToolName(null)).toBe("");
    expect(extractToolName({ tool_name: "   " })).toBe("");
  });
});

describe("extractToolTarget", () => {
  // The whole point of the field: `Bash` alone is a noun, `rm src/legacy/shim.ts`
  // is something an operator can approve or refuse from a phone.
  it("takes the command for Bash", () => {
    expect(extractToolTarget({ tool_name: "Bash", tool_input: { command: "rm src/legacy/shim.ts" } }))
      .toBe("rm src/legacy/shim.ts");
  });

  it.each([
    ["Read", { file_path: "src/legacy/shim.ts" }, "src/legacy/shim.ts"],
    ["Edit", { file_path: "src/app.ts" }, "src/app.ts"],
    ["NotebookEdit", { notebook_path: "nb.ipynb" }, "nb.ipynb"],
    ["Glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["WebFetch", { url: "https://example.com" }, "https://example.com"],
    ["Task", { description: "audit the auth layer" }, "audit the auth layer"],
  ])("takes the salient argument for %s", (_tool, input, expected) => {
    expect(extractToolTarget({ tool_input: input })).toBe(expected);
  });

  // Grep sends both; the pattern is what the operator recognises, and the path is
  // scope. Command-shaped keys must not lose to a path that merely accompanies them.
  it("prefers the pattern over the path it searches", () => {
    expect(extractToolTarget({ tool_input: { pattern: "TODO", path: "src/" } })).toBe("TODO");
  });

  it("prefers the command over any path that accompanies it", () => {
    expect(extractToolTarget({ tool_input: { command: "ls -la", path: "/tmp" } })).toBe("ls -la");
  });

  it("accepts camelCase input, since not every runner sends snake_case", () => {
    expect(extractToolTarget({ toolInput: { filePath: "a/b.ts" } })).toBe("a/b.ts");
  });

  // A missing target is normal — some tools take no argument worth showing — and
  // it must read as absent rather than as the string "undefined".
  it("returns empty when there is nothing worth showing", () => {
    expect(extractToolTarget({ tool_name: "Bash" })).toBe("");
    expect(extractToolTarget({ tool_input: {} })).toBe("");
    expect(extractToolTarget({ tool_input: { command: "   " } })).toBe("");
    expect(extractToolTarget(null)).toBe("");
  });

  // A heredoc or a pasted file can make `command` enormous; the drop file has a
  // budget and the phone has one line.
  it("collapses newlines so a heredoc stays one line", () => {
    expect(extractToolTarget({ tool_input: { command: "cat <<EOF\nline1\nline2\nEOF" } }))
      .toBe("cat <<EOF line1 line2 EOF");
  });

  it("ignores a non-object tool_input rather than stringifying it", () => {
    expect(extractToolTarget({ tool_input: "rm -rf /" })).toBe("");
    expect(extractToolTarget({ tool_input: ["a"] })).toBe("");
  });
});

// Shapes below are verbatim from a PostToolUse capture run against Claude Code
// 2.1.221 (see plans/lotus-pocket/issues/09). `tool_response` differs per tool —
// Read returns { type, file }, Bash returns { stdout, stderr } — which is why
// none of this was guessed.
describe("extractToolDiffStat", () => {
  const editResponse = {
    tool_name: "Edit",
    tool_response: {
      filePath: "/tmp/work/sample.txt",
      oldString: "beta",
      newString: "BETA",
      originalFile: "alpha\nbeta\ngamma\n",
      replaceAll: false,
      userModified: false,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [" alpha", "-beta", "+BETA", " gamma"],
        },
      ],
    },
  };

  it("counts added and removed lines from structuredPatch", () => {
    expect(extractToolDiffStat(editResponse)).toEqual({ added: 1, removed: 1 });
  });

  it("ignores context lines, which carry a leading space", () => {
    const patch = {
      tool_response: {
        structuredPatch: [{ lines: [" keep", "-gone", "-gone2", "+new", " keep2"] }],
      },
    };
    expect(extractToolDiffStat(patch)).toEqual({ added: 1, removed: 2 });
  });

  it("sums across hunks", () => {
    const patch = {
      tool_response: {
        structuredPatch: [{ lines: ["-a", "+b"] }, { lines: ["-c", "+d", "+e"] }],
      },
    };
    expect(extractToolDiffStat(patch)).toEqual({ added: 3, removed: 2 });
  });

  // The finding that a naive implementation gets wrong: creating a file yields an
  // EMPTY structuredPatch, so counting hunks alone reports +0 -0 for a brand new
  // three-line file. `type: "create"` and a null originalFile say so explicitly.
  it("counts a created file from its content, not from the empty patch", () => {
    const write = {
      tool_name: "Write",
      tool_response: {
        type: "create",
        filePath: "/tmp/work/notes.txt",
        originalFile: null,
        content: "one\ntwo\nthree\n",
        userModified: false,
        structuredPatch: [],
      },
    };

    expect(extractToolDiffStat(write)).toEqual({ added: 3, removed: 0 });
  });

  it("does not count a trailing newline as a fourth line", () => {
    const write = {
      tool_response: { type: "create", originalFile: null, content: "a\nb\n", structuredPatch: [] },
    };
    expect(extractToolDiffStat(write)).toEqual({ added: 2, removed: 0 });
  });

  // Read and Bash have no diff at all, and inventing one would put a stat on a
  // step that changed nothing.
  it.each([
    ["Read", { type: "text", file: { filePath: "/a", content: "x", numLines: 1 } }],
    ["Bash", { stdout: "3 notes.txt\n", stderr: "", interrupted: false, isImage: false }],
  ])("returns null for %s, which has no diff", (_tool, tool_response) => {
    expect(extractToolDiffStat({ tool_response })).toBeNull();
  });

  it("returns null when there is nothing to read", () => {
    expect(extractToolDiffStat(null)).toBeNull();
    expect(extractToolDiffStat({})).toBeNull();
    expect(extractToolDiffStat({ tool_response: "some string" })).toBeNull();
    expect(extractToolDiffStat({ tool_response: { structuredPatch: [] } })).toBeNull();
  });

  it("survives a malformed patch rather than throwing", () => {
    expect(extractToolDiffStat({ tool_response: { structuredPatch: "nope" } })).toBeNull();
    expect(extractToolDiffStat({ tool_response: { structuredPatch: [{ lines: "nope" }] } })).toBeNull();
  });
});

describe("looksLikeToolFailure", () => {
  // These four shapes are inherited from the shell hook this replaced, whose own
  // ground truth was Heard's `templates.post_tool_event` — NOT an observed Claude
  // Code payload. Three capture runs against Claude Code 2.1.221 never produced
  // any of them, because a tool that fails emits no PostToolUse at all. They are
  // kept because losing a failure signal is worse than carrying an unused branch,
  // and deleting them on three observations would be deleting someone else's
  // evidence with less of my own.
  it.each([
    ["exit_code non-zero", { exit_code: 1 }],
    ["exitCode non-zero", { exitCode: 127 }],
    ["success false", { success: false }],
    ["error key", { error: "ENOENT" }],
    ["is_error true", { is_error: true }],
  ])("reads %s as a failure", (_label, tool_response) => {
    expect(looksLikeToolFailure({ tool_name: "Bash", tool_response })).toBe(true);
  });

  it.each([
    ["exit 0", { exit_code: 0 }],
    ["success true", { success: true }],
    ["a plain Bash result", { stdout: "ok", stderr: "", interrupted: false }],
    ["an Edit result", { filePath: "a.ts", structuredPatch: [] }],
  ])("leaves %s routine", (_label, tool_response) => {
    expect(looksLikeToolFailure({ tool_name: "Bash", tool_response })).toBe(false);
  });

  // The case the shell version got right and a naive rewrite gets wrong: grepping
  // for the word "error", or editing error-handling code, must never read as a
  // failure that did not happen.
  it("ignores failure words in the tool's own input", () => {
    expect(
      looksLikeToolFailure({
        tool_name: "Grep",
        tool_input: { pattern: "error", path: "src/" },
        tool_response: { stdout: "3 matches" },
      }),
    ).toBe(false);
    expect(
      looksLikeToolFailure({
        tool_name: "Edit",
        tool_input: { old_string: '{"success":false}', new_string: "x" },
        tool_response: { filePath: "a.ts" },
      }),
    ).toBe(false);
  });

  it("returns false when there is nothing to judge", () => {
    expect(looksLikeToolFailure(null)).toBe(false);
    expect(looksLikeToolFailure({})).toBe(false);
    expect(looksLikeToolFailure({ tool_response: "a string" })).toBe(false);
  });
});

describe("extractTranscriptPath", () => {
  it("reads the path both agent CLIs actually send", () => {
    // Verbatim shapes from the capture in plans/session-history-hardening/issues/02.
    expect(extractTranscriptPath({ transcript_path: "/Users/x/.codex/sessions/rollout.jsonl" }))
      .toBe("/Users/x/.codex/sessions/rollout.jsonl");
    expect(extractTranscriptPath({ transcriptPath: "/Users/x/.claude/projects/a.jsonl" }))
      .toBe("/Users/x/.claude/projects/a.jsonl");
  });

  it("answers empty rather than guessing when the hook says nothing", () => {
    expect(extractTranscriptPath({})).toBe("");
    expect(extractTranscriptPath(null)).toBe("");
    expect(extractTranscriptPath({ transcript_path: "   " })).toBe("");
  });
});
