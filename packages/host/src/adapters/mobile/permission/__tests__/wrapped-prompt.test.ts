import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parsePermissionPrompt } from "../prompt.js";

/**
 * Captures from `devbox-vps`, claude 2.1.263, taken with `tmux capture-pane -p` and stored byte
 * for byte — whole panes, not excerpts, so a rule that swallows the output above a prompt fails
 * here rather than in front of an operator (`issues/17`).
 */
function capture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", name), "utf8");
}

const WRITE_80 = capture("write-prompt-80col.txt");
const WRITE_60 = capture("write-prompt-60col.txt");
const BASH_60 = capture("bash-prompt-60col.txt");
const QUESTION_60 = capture("wrapped-question-60col.txt");

/** The label `issues/17` was opened for: it needs two rows at 80 columns and three at 60. */
const ACCEPT_EDITS =
  "Yes, and switch to accept edits (auto-approve file edits and common file commands) "
  + "for this session (shift+tab)";

describe("wrapped labels", () => {
  it("puts a label split across two rows back together", () => {
    const prompt = parsePermissionPrompt(WRITE_80, 80);

    expect(prompt?.question).toBe("Do you want to create wrap-probe.txt?");
    expect(prompt?.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(prompt?.options[1]?.label).toBe(ACCEPT_EDITS);
    expect(prompt?.options[2]?.label).toBe("No");
  });

  /** Same prompt, narrower pane: the same label now arrives in three rows. */
  it("puts a label split across three rows back together", () => {
    expect(parsePermissionPrompt(WRITE_60, 60)?.options[1]?.label).toBe(ACCEPT_EDITS);
  });

  it("handles a four-option prompt with two wrapped labels", () => {
    const prompt = parsePermissionPrompt(BASH_60, 60);

    expect(prompt?.question).toBe("Do you want to proceed?");
    expect(prompt?.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and always allow access to /home/alwi/lotus-probe from this project",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "No",
    ]);
  });

  it("keeps the selection marker on the option that carries it", () => {
    expect(parsePermissionPrompt(WRITE_80, 80)?.options.map((o) => o.selected))
      .toEqual([true, false, false]);
  });
});

describe("wrapped question", () => {
  /**
   * The question breaks mid-token, so joining it with a space would hand the operator a filename
   * that does not exist — the one thing worse than no chips at all.
   */
  it("rejoins a question broken mid-token, without inserting a space", () => {
    const prompt = parsePermissionPrompt(QUESTION_60, 60);

    expect(prompt?.question)
      .toBe("Do you want to create sangat-panjang-untuk-menguji-pembungkusan-baris-pertanyaan.txt?");
    expect(prompt?.options).toHaveLength(3);
  });

  /**
   * Without a pane width the "filled to the edge" signal is gone, and one signal alone is a
   * guess. The parser keeps the single row it can see rather than inventing the rest.
   */
  it("does not reconstruct a wrapped question when the width is unknown", () => {
    expect(parsePermissionPrompt(QUESTION_60)?.question).toBe("kusan-baris-pertanyaan.txt?");
  });
});

describe("wrapped labels still fail closed", () => {
  it("rejects a run whose continuation has no option above it", () => {
    const truncated = [
      "Do you want to proceed?",
      "      commands) for this session (shift+tab)",
      "  3. No",
      "",
    ].join("\n");

    expect(parsePermissionPrompt(truncated, 80)).toBeUndefined();
  });

  it("does not treat output indented differently from the label column as a continuation", () => {
    const stray = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and switch to accept edits",
      "    off-by-two, so not this label's row",
      "  3. No",
      "",
    ].join("\n");

    expect(parsePermissionPrompt(stray, 80)).toBeUndefined();
  });

  it("stops a run rather than swallowing the paragraph above it", () => {
    const prose = [
      "Some ordinary output about a file",
      "      that happens to be indented deeply",
      "❯ 1. Yes",
      "  2. No",
      "",
    ].join("\n");

    expect(parsePermissionPrompt(prose, 80)).toBeUndefined();
  });

  it("refuses a label that grows past the joined cap", () => {
    const giant = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      `  2. ${"a".repeat(110)}`,
      `     ${"b".repeat(110)}`,
      "  3. No",
      "",
    ].join("\n");

    expect(parsePermissionPrompt(giant, 80)).toBeUndefined();
  });
});
