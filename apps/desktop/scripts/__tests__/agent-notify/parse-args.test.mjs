import { describe, it, expect } from "vitest";
import { parseArgs } from "../../agent-notify/parse-args.mjs";

describe("parseArgs", () => {
  it("returns empty object for empty argv", () => {
    expect(parseArgs([])).toEqual({});
  });

  it("parses --key value pairs", () => {
    expect(parseArgs(["--agent", "claude", "--event", "stop"])).toEqual({
      agent: "claude",
      event: "stop",
    });
  });

  it("parses kebab-case keys verbatim", () => {
    expect(parseArgs(["--session-id", "abc-123", "--user-prompt", "hi"])).toEqual({
      "session-id": "abc-123",
      "user-prompt": "hi",
    });
  });

  it("treats lone --flag (no value) as boolean string 'true'", () => {
    expect(parseArgs(["--verbose"])).toEqual({ verbose: "true" });
  });

  it("treats --flag followed by another --flag as boolean", () => {
    expect(parseArgs(["--verbose", "--agent", "claude"])).toEqual({
      verbose: "true",
      agent: "claude",
    });
  });

  it("ignores positional args without -- prefix", () => {
    expect(parseArgs(["positional", "--agent", "claude", "another"])).toEqual({
      agent: "claude",
    });
  });

  it("last value wins for repeated keys", () => {
    expect(parseArgs(["--agent", "claude", "--agent", "codex"])).toEqual({
      agent: "codex",
    });
  });

  it("preserves values containing spaces and equals signs", () => {
    expect(parseArgs(["--body", "hello world = ok"])).toEqual({
      body: "hello world = ok",
    });
  });

  it("preserves values that look like negative numbers", () => {
    expect(parseArgs(["--count", "-5"])).toEqual({ count: "-5" });
  });
});
