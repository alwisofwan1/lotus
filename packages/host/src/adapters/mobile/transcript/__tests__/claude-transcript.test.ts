import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readClaudeTranscript } from "../claude-transcript.js";

/**
 * Slice 3.2. Real lines from a real session on `devbox-vps` (claude 2.1.263, 2026-09-06), run
 * under a **clean** `CLAUDE_CONFIG_DIR` on purpose: the first capture carried the operator's own
 * gateway configuration and private skill catalogue inside the system prompt, which has no
 * business in a repository.
 *
 * The bulky `attachment` lines this reader ignores entirely are dropped so the fixture stays a
 * fixture — 8 KB rather than 20. Every line kept is verbatim.
 */
const SESSION = readFileSync(join(__dirname, "fixtures", "claude-session.jsonl"), "utf8");

describe("readClaudeTranscript", () => {
  it("reads a session as the entries Chat already renders", () => {
    const entries = readClaudeTranscript(SESSION);

    expect(entries.map((e) => e.event)).toEqual([
      "prompt-submit",
      "tool-pre",
      "tool-post",
      "tool-pre",
      "tool-post",
      "stop",
    ]);
  });

  it("keeps the operator's own words as the prompt", () => {
    const [prompt] = readClaudeTranscript(SESSION);

    expect(prompt?.title).toBe("You");
    expect(prompt?.userPrompt).toBe(
      "Baca berkas catatan.txt lalu jawab satu kalimat pendek apa isinya.",
    );
    expect(prompt?.body).toBe(prompt?.userPrompt);
  });

  /**
   * The fixture happens to exercise two of the target keys, which is the argument for using a
   * real session: a `command` for Bash and a `file_path` for Read, in one file.
   */
  it("names the tool and the argument that says what it touched", () => {
    const steps = readClaudeTranscript(SESSION).filter((e) => e.event === "tool-pre");

    expect(steps[0]).toMatchObject({
      title: "Bash",
      toolTarget: "fd -a catatan.txt / 2>/dev/null | head -5; ls catatan.txt 2>/dev/null",
    });
    expect(steps[1]).toMatchObject({
      title: "Read",
      toolTarget: "/home/alwi/trclean/catatan.txt",
    });
  });

  it("ends with the agent's prose", () => {
    const entries = readClaudeTranscript(SESSION);
    const last = entries[entries.length - 1];

    expect(last?.event).toBe("stop");
    expect(last?.title).toBe("Finished working");
    expect(last?.body).toBe('Isinya cuma teks "halo".');
  });

  /**
   * The file is the unclamped source — that is the whole reason for reading it instead of the
   * desktop's 60-entry ring, which evicted 11.7% of entries and started empty after a restart.
   */
  it("never marks a body truncated, because nothing here was cut", () => {
    for (const entry of readClaudeTranscript(SESSION)) {
      expect(entry.bodyTruncated).toBeUndefined();
    }
  });

  it("orders entries oldest first, by the timestamps in the file", () => {
    const times = readClaudeTranscript(SESSION).map((e) => e.timestamp);

    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(Date.parse("2026-09-06T15:10:43.508Z"));
  });

  describe("what it deliberately leaves out", () => {
    /** `thinking` is not what Chat renders, and it is the largest thing in these files. */
    it("skips thinking blocks", () => {
      const bodies = readClaudeTranscript(SESSION).map((e) => e.body);

      expect(bodies.some((b) => b.includes("The user wants me to"))).toBe(false);
      expect(readClaudeTranscript(SESSION)).toHaveLength(6);
    });

    it("ignores the line kinds that are not conversation", () => {
      const noise = [
        JSON.stringify({ type: "queue-operation", timestamp: "2026-09-06T15:10:43.434Z" }),
        JSON.stringify({ type: "ai-title", title: "reading a file" }),
        JSON.stringify({ type: "last-prompt" }),
        JSON.stringify({ type: "file-history-snapshot" }),
      ].join("\n");

      expect(readClaudeTranscript(noise)).toEqual([]);
    });
  });

  describe("surviving a file it did not expect", () => {
    it("skips a line it cannot parse and keeps the rest", () => {
      const mixed = [
        "{not json",
        JSON.stringify({
          type: "user",
          timestamp: "2026-09-06T15:10:43.508Z",
          message: { content: "still here" },
        }),
        "",
      ].join("\n");

      expect(readClaudeTranscript(mixed).map((e) => e.userPrompt)).toEqual(["still here"]);
    });

    /**
     * A `user` line with a **string** body is the operator typing; with a **list** it is tool
     * results being fed back. Content shape decides the meaning, not `type` — Claude sends both
     * as `user`.
     */
    it("tells the operator's message from tool output coming back", () => {
      const both = [
        JSON.stringify({ type: "user", message: { content: "   " } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
      ].join("\n");

      // The blank prompt is dropped; the tool result is a step.
      expect(readClaudeTranscript(both).map((e) => e.event)).toEqual(["tool-post"]);
    });

    it("stamps zero on a timestamp it cannot read, rather than dropping the entry", () => {
      const line = JSON.stringify({
        type: "user",
        timestamp: "not a date",
        message: { content: "said anyway" },
      });

      expect(readClaudeTranscript(line)[0]).toMatchObject({ userPrompt: "said anyway", timestamp: 0 });
    });

    it("says Tool when a call arrives with no name", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", input: { command: "ls" } }] },
      });

      expect(readClaudeTranscript(line)[0]).toMatchObject({ title: "Tool", toolTarget: "ls" });
    });

    /** A multi-line command becomes one line, the same way the hook producer flattens it. */
    it("flattens a tool target onto one line", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "a\n  b\n\nc" } }] },
      });

      expect(readClaudeTranscript(line)[0]?.toolTarget).toBe("a b c");
    });
  });
});

/**
 * **A question the agent is asking arrives here whole, and used to be thrown away one line
 * later.**
 *
 * `AskUserQuestion` carries its questions, its options and their descriptions in the tool's own
 * input, and the CLI writes all of it to this file. The reader looked for `command`, `file_path`,
 * `path`, `pattern`, `url`, `prompt` — none of which it has — so a real five-option question
 * reached the phone as a bare step reading `askuserquestion`, and Chat fell back to scraping the
 * terminal for words that were already on disk. Reported from a device 2026-09-09.
 *
 * Captured from a real transcript (`~/.claude/projects/…/0445edc2….jsonl`), trimmed to two
 * options. `bb` models this as an interaction of its own rather than a permission
 * (`user-question-form-state.ts`), which is the shape this feeds.
 */
describe("a question the agent is putting to the operator", () => {
  const ASKING = JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-09T08:00:00.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_9",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Resolusi & orientasi output untuk Resolume?",
                header: "Resolusi",
                multiSelect: false,
                options: [
                  { label: "1920×1080 (Full HD landscape)", description: "Paling umum untuk layar acara." },
                  { label: "1080×1920 (Vertical)", description: "Untuk LED portrait." },
                ],
              },
            ],
          },
        },
      ],
    },
  });

  it("keeps the question, its options and their descriptions", () => {
    const step = readClaudeTranscript(ASKING).find((e) => e.event === "tool-pre");

    // `multiSelect: false` is dropped, not echoed: absent means one choice, and a client that
    // has to read a `false` to learn the ordinary case is a client that will forget to.
    expect(step?.questions).toEqual([
      {
        question: "Resolusi & orientasi output untuk Resolume?",
        header: "Resolusi",
        options: [
          { label: "1920×1080 (Full HD landscape)", description: "Paling umum untuk layar acara." },
          { label: "1080×1920 (Vertical)", description: "Untuk LED portrait." },
        ],
      },
    ]);
  });

  it("names the step by what is being asked, not by the tool", () => {
    // `askuserquestion` with an empty target is what the phone drew before this.
    const step = readClaudeTranscript(ASKING).find((e) => e.event === "tool-pre");

    expect(step?.toolTarget).toBe("Resolusi & orientasi output untuk Resolume?");
  });

  it("leaves every other tool exactly as it was", () => {
    const bash = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-09T08:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }],
      },
    });
    const step = readClaudeTranscript(bash).find((e) => e.event === "tool-pre");

    expect(step?.toolTarget).toBe("ls -la");
    expect(step?.questions).toBeUndefined();
  });
});

/**
 * **What the operator did about it, from the runner's own record.**
 *
 * Probed against real transcripts on 2026-09-09: pressing Esc writes a `tool_result` with
 * `is_error: true` and *"The user doesn't want to proceed with this tool use…"*; answering
 * writes *`Your questions have been answered: "Q"="A"`*. Both are keyed by `tool_use_id`, and
 * neither was being read — so a card the phone drew stayed on screen forever, whatever the
 * operator did at the keyboard. `bb` calls this the interaction's resolution
 * (`domain/pending-interactions.ts`), and it is what makes a question a thing with an end.
 */
describe("what became of a question", () => {
  const resultLine = (content: unknown, isError?: boolean) =>
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-09T08:00:05.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_9", content, ...(isError === undefined ? {} : { is_error: isError }) },
        ],
      },
    });

  it("carries the call id on both halves, so a result can find what it answers", () => {
    const askLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-09T08:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_9",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Tabs or spaces?", options: [{ label: "Tabs" }] }] },
          },
        ],
      },
    });
    const asked = readClaudeTranscript(askLine).find((e) => e.event === "tool-pre");
    const done = readClaudeTranscript(resultLine("ok"))[0];

    expect(asked?.toolCallId).toBe("toolu_9");
    expect(done?.toolCallId).toBe("toolu_9");
  });

  it("reads the chosen answer out of the runner's own sentence", () => {
    const done = readClaudeTranscript(
      resultLine('Your questions have been answered: "Tabs or spaces?"="Tabs". You can now continue.'),
    )[0];

    expect(done?.answers).toEqual({ "Tabs or spaces?": ["Tabs"] });
  });

  it("reads every question when more than one was put at once", () => {
    const done = readClaudeTranscript(
      resultLine('The user answered: "Resolusi?"="1920×1080", "Durasi?"="5 detik"'),
    )[0];

    expect(done?.answers).toEqual({ "Resolusi?": ["1920×1080"], "Durasi?": ["5 detik"] });
  });

  /// Esc. The vocabulary already had a word for it, so this needs no new one.
  it("says a cancelled call in the word the rest of Chat already uses", () => {
    const done = readClaudeTranscript(
      resultLine("The user doesn't want to proceed with this tool use. The tool use was rejected", true),
    )[0];

    expect(done?.event).toBe("tool-post-failed");
    expect(done?.answers).toBeUndefined();
  });

  it("leaves an ordinary tool result carrying no answers", () => {
    const done = readClaudeTranscript(resultLine([{ type: "text", text: "ddd9b9be" }]))[0];

    expect(done?.event).toBe("tool-post");
    expect(done?.answers).toBeUndefined();
  });
});

/**
 * **Esc ends the turn, and the file is the only place that says so.**
 *
 * Read off a live cell on 2026-09-09: refusing a question writes the rejection result and then
 * a `user` message reading *"[Request interrupted by user for tool use]"* — and nothing else.
 * No `stop`, no closing prose. The turn stayed open on a phone for three and a half minutes,
 * with a spinner and a STOP button, because nothing it could see had ended.
 */
describe("a turn the operator interrupted", () => {
  const interrupted = JSON.stringify({
    type: "user",
    timestamp: "2026-09-09T08:00:06.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
    },
  });

  it("is an error step in the word the rest of Chat already uses", () => {
    const entries = readClaudeTranscript(interrupted);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: "error", status: "error", title: "Interrupted" });
  });

  it("leaves an ordinary sentence the operator typed as the prompt it is", () => {
    const typed = JSON.stringify({
      type: "user",
      timestamp: "2026-09-09T08:00:06.000Z",
      message: { role: "user", content: [{ type: "text", text: "carry on" }] },
    });

    expect(readClaudeTranscript(typed)[0]).toMatchObject({
      event: "prompt-submit",
      userPrompt: "carry on",
    });
  });
});

