import { describe, expect, it } from "vitest";

import { parsePermissionPrompt, spokenReadback } from "../prompt.js";

/**
 * Ported from `permission_prompt.rs`'s own suite along with the code, cases and reasons intact.
 * The failing-closed half matters more than the parsing half: a wrong digit approves the thing
 * the operator meant to refuse (ADR-8).
 */

/**
 * Verbatim from the ADR-8 spike capture in `plans/lotus-pocket/PLAN.md`. Real output, not a
 * reconstruction — which is why option 3 is "No" and not the longer label the mockups invented.
 */
const CAPTURED = [
  "Create file approved.txt",
  "\u256c\u256c\u256c\u256c\u256c\u256c\u256c\u256c",
  " 1  hi",
  "\u256c\u256c\u256c\u256c\u256c\u256c\u256c\u256c",
  "Do you want to create approved.txt?",
  "\u276f 1. Yes",
  "  2. Yes, allow all edits during this session (shift+tab)",
  "  3. No",
  "",
].join("\n");

const ESC = "\u001b";

describe("parsePermissionPrompt", () => {
  it("parses the captured prompt", () => {
    const prompt = parsePermissionPrompt(CAPTURED);

    expect(prompt?.question).toBe("Do you want to create approved.txt?");
    expect(prompt?.options).toEqual([
      { key: "1", label: "Yes", selected: true },
      { key: "2", label: "Yes, allow all edits during this session (shift+tab)", selected: false },
      { key: "3", label: "No", selected: false },
    ]);
  });

  /**
   * The labels are the product here. Paraphrasing them is how an operator loses the ability to
   * check what they are about to press.
   */
  it("keeps labels verbatim, and they differ per tool", () => {
    const bash = [
      "Do you want to run this command?",
      "\u276f 1. Yes",
      "  2. Yes, allow all Bash during this session",
      "  3. No",
      "",
    ].join("\n");

    expect(parsePermissionPrompt(bash)?.options[1]?.label)
      .toBe("Yes, allow all Bash during this session");
  });

  it("takes the last prompt when the tail holds several", () => {
    const tail = [
      "Do you want to run the first thing?",
      "\u276f 1. Yes",
      "  2. No",
      "some output in between",
      "Do you want to run the second thing?",
      "  1. Yes",
      "\u276f 2. No",
      "",
    ].join("\n");

    const prompt = parsePermissionPrompt(tail);

    expect(prompt?.question).toBe("Do you want to run the second thing?");
    expect(prompt?.options[1]?.selected).toBe(true);
  });

  it("survives ansi colouring", () => {
    const coloured = [
      `${ESC}[33mDo you want to run this command?${ESC}[0m`,
      `${ESC}[1m\u276f 1. Yes${ESC}[0m`,
      `${ESC}[2m  2. No${ESC}[0m`,
      "",
    ].join("\n");

    const prompt = parsePermissionPrompt(coloured);

    expect(prompt?.question).toBe("Do you want to run this command?");
    expect(prompt?.options[1]?.label).toBe("No");
  });

  describe("failing closed", () => {
    /**
     * The dangerous case: option 1 scrolled away, so "the first button" would send `2` and mean
     * something else entirely.
     */
    it("refuses a run that does not start at one", () => {
      expect(parsePermissionPrompt("Do you want to run this command?\n  2. Yes\n  3. No\n"))
        .toBeUndefined();
    });

    it("refuses a run with a gap", () => {
      expect(parsePermissionPrompt("Do you want to run this command?\n  1. Yes\n  3. No\n"))
        .toBeUndefined();
    });

    /**
     * Ordinary numbered output is far more common than prompts, and treating it as one would put
     * buttons on a cell that is not asking anything.
     */
    it("refuses a single numbered line", () => {
      expect(parsePermissionPrompt("Installing deps?\n  1. lodash\n")).toBeUndefined();
    });

    it("refuses a numbered list with no question above it", () => {
      expect(parsePermissionPrompt("Here is the plan.\n  1. Yes\n  2. No\n")).toBeUndefined();
    });

    it("refuses a numbered run that starts at line zero", () => {
      expect(parsePermissionPrompt("  1. Yes\n  2. No\n")).toBeUndefined();
    });

    it("refuses a long numbered list", () => {
      const lines = ["Which one?"];
      for (let i = 1; i <= 7; i += 1) lines.push(`  ${i}. option`);
      expect(parsePermissionPrompt(lines.join("\n"))).toBeUndefined();
    });

    it("refuses output with no numbered run at all", () => {
      expect(parsePermissionPrompt("just some output\nand more\n")).toBeUndefined();
    });

    it("refuses a label longer than a button could honestly show", () => {
      const long = "x".repeat(121);
      expect(parsePermissionPrompt(`Do you want to?\n  1. ${long}\n  2. No\n`)).toBeUndefined();
    });

    it("refuses a key that is not a digit", () => {
      expect(parsePermissionPrompt("Do you want to?\n  a. Yes\n  b. No\n")).toBeUndefined();
    });
  });

  describe("spoken read-back", () => {
    it("keeps the question and every option verbatim", () => {
      const spoken = spokenReadback(parsePermissionPrompt(CAPTURED)!);

      expect(spoken).toBe(
        "Do you want to create approved.txt? " +
        "Option 1: Yes. " +
        "Option 2: Yes, allow all edits during this session. " +
        "Option 3: No.",
      );
    });

    /** A keyboard hint is noise read aloud and changes nothing about the choice. */
    it("drops keyboard hints", () => {
      const spoken = spokenReadback({
        question: "Do you want to?",
        options: [
          { key: "1", label: "Yes (enter)", selected: true },
          { key: "2", label: "No (esc)", selected: false },
        ],
      });

      expect(spoken).not.toContain("enter");
      expect(spoken).not.toContain("esc");
      expect(spoken).toContain("Option 1: Yes.");
    });

    /**
     * The line where stripping too eagerly would be dangerous: a parenthetical that is prose is
     * part of what the operator is agreeing to.
     */
    it("keeps a parenthetical that is prose", () => {
      const spoken = spokenReadback({
        question: "Do you want to reset?",
        options: [
          { key: "1", label: "Yes (this cannot be undone)", selected: true },
          { key: "2", label: "No", selected: false },
        ],
      });

      expect(spoken).toContain("(this cannot be undone)");
    });

    it("names the digits so the answer can be spoken", () => {
      const spoken = spokenReadback(parsePermissionPrompt(CAPTURED)!);

      for (const key of ["Option 1", "Option 2", "Option 3"]) expect(spoken).toContain(key);
    });
  });
});
