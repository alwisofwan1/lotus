import { describe, expect, it, vi } from "vitest";

import { parseSmartConvertDraft } from "../smart-convert-runner";

describe("parseSmartConvertDraft", () => {
  it("extracts JSON from fenced or prefaced model responses", () => {
    const raw = [
      "Sure — here is the JSON:",
      "",
      "```json",
      "{",
      "  \"title\": \"Ship the note conversion\",",
      "  \"intent\": \"Turn a rough note into a verifiable task.\",",
      "  \"acceptanceCriteria\": [\"User can confirm the task\", \"Invalid output is rejected\"],",
      "  \"taskClass\": \"deep-focus\",",
      "  \"when\": \"this-week\",",
      "  \"subtasks\": [\"Add parser tests\"]",
      "}",
      "```",
    ].join("\n");
    const draft = parseSmartConvertDraft(raw);

    expect(draft).toMatchObject({
      title: "Ship the note conversion",
      intent: "Turn a rough note into a verifiable task.",
      taskClass: "deep-focus",
      when: "this-week",
      subtasks: ["Add parser tests"],
    });
    expect(draft.acceptanceCriteria).toHaveLength(2);
    expect(draft.acceptanceCriteria[0]).toMatchObject({ text: "User can confirm the task", done: false });
  });

  it("normalizes malformed fields into a safe editable draft", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "criterion-id" });
    const draft = parseSmartConvertDraft(JSON.stringify({
      title: "x".repeat(120),
      intent: null,
      acceptanceCriteria: ["", "  Keep meaningful criterion  ", 42],
      taskClass: "unknown",
      when: "later",
      subtasks: ["", "  one  ", "two"],
    }));

    expect(draft.title).toHaveLength(80);
    expect(draft.intent).toBe("");
    expect(draft.acceptanceCriteria.map((c) => c.text)).toEqual(["Keep meaningful criterion", "42"]);
    expect(draft.taskClass).toBe("quick");
    expect(draft.when).toBe("whenever");
    expect(draft.subtasks).toEqual(["one", "two"]);
    vi.unstubAllGlobals();
  });
});
