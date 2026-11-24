import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeSessionHeadline } from "../claude-transcript.js";

const record = (row: Record<string, unknown>): string => JSON.stringify(row);

describe("claudeSessionHeadline", () => {
  it("prefers the CLI's own title over the prompt that started it", () => {
    // After a few turns the operator's first sentence stops describing the cell; the CLI's
    // summary keeps up, which is why it wins.
    const text = [
      record({ type: "last-prompt", lastPrompt: "Buatkan pantun" }),
      record({ type: "ai-title", aiTitle: "Pembuatan pantun" }),
    ].join("\n");
    expect(claudeSessionHeadline(text)).toBe("Pembuatan pantun");
  });

  it("falls back to the operator's own words, which is what the bridge path shows", () => {
    expect(claudeSessionHeadline(record({ type: "last-prompt", lastPrompt: "List files" }))).toBe("List files");
  });

  it("takes the newest of each, because the CLI rewrites them", () => {
    const text = [
      record({ type: "ai-title", aiTitle: "List files" }),
      record({ type: "ai-title", aiTitle: "Pantun" }),
    ].join("\n");
    expect(claudeSessionHeadline(text)).toBe("Pantun");
  });

  it("keeps one line of a pasted paragraph", () => {
    const text = record({ type: "last-prompt", lastPrompt: "  fix the tests\nthen commit  " });
    expect(claudeSessionHeadline(text)).toBe("fix the tests");
  });

  it("says nothing for a session that has neither, and survives a half-written line", () => {
    expect(claudeSessionHeadline("")).toBeUndefined();
    expect(claudeSessionHeadline('{"type":"ai-tit')).toBeUndefined();
    expect(claudeSessionHeadline(record({ type: "ai-title" }))).toBeUndefined();
    expect(claudeSessionHeadline(record({ type: "ai-title", aiTitle: "   " }))).toBeUndefined();
  });

  it("reads one out of a real session capture", () => {
    const text = readFileSync(join(__dirname, "fixtures", "claude-session.jsonl"), "utf8");
    // Whatever that capture holds, a headline is either a non-empty line or absent — never "".
    const headline = claudeSessionHeadline(text);
    expect(headline === undefined || headline.length > 0).toBe(true);
  });
});
