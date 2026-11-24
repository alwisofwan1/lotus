import { describe, expect, it } from "vitest";

import { runnerTranscriptCaps } from "../runner-caps.js";

describe("runnerTranscriptCaps", () => {
  it("claude reports turns, text and tool calls; status, diff and permission are derived", () => {
    const caps = runnerTranscriptCaps("claude");
    expect(caps).toMatchObject({ turns: "expected", text: "expected", toolCalls: "expected", toolStatus: "partial", diff: "partial", permission: "partial" });
    expect(caps).toMatchObject({ streaming: "never", reasoning: "never", plan: "never", usage: "never" });
  });

  it("codex never asks permission through Lotus, and everything else matches claude's pipeline", () => {
    const caps = runnerTranscriptCaps("codex");
    expect(caps.permission).toBe("never");
    expect(caps).toMatchObject({ turns: "expected", text: "expected", toolCalls: "expected", diff: "partial" });
  });

  it("cursor: text and tools from its file, no diff and no permission", () => {
    expect(runnerTranscriptCaps("cursor")).toMatchObject({ turns: "partial", text: "expected", toolCalls: "expected", diff: "never", permission: "never" });
  });

  it("a runner this host installs nothing for is never across the board", () => {
    for (const r of ["custom", "gemini", "opencode", undefined]) {
      expect(Object.values(runnerTranscriptCaps(r)).every((l) => l === "never"), String(r)).toBe(true);
    }
  });

  it("hands out a copy, so a caller cannot edit the table", () => {
    const a = runnerTranscriptCaps("claude");
    a.text = "never";
    expect(runnerTranscriptCaps("claude").text).toBe("expected");
  });
});
