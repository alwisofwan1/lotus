import { describe, expect, it } from "vitest";
import { planLiveAgentPaste } from "../live-agent-paste";

describe("planLiveAgentPaste", () => {
  it("bracket-wraps multi-line text so the runner treats it as a paste, not submits", () => {
    const plan = planLiveAgentPaste({
      types: ["text/plain"],
      text: "line one\nline two\r\nline three",
    });

    expect(plan).toBe("\x1b[200~line one\rline two\rline three\x1b[201~");
  });

  it("lets an image paste flow natively (CLI clipboard-attach owns it)", () => {
    expect(planLiveAgentPaste({ types: ["Files"], text: "" })).toBeNull();
    // Some sources put both a file and a text fallback on the clipboard — the image wins.
    expect(planLiveAgentPaste({ types: ["Files", "text/plain"], text: "screenshot.png" })).toBeNull();
  });

  it("lets an empty text paste flow natively", () => {
    expect(planLiveAgentPaste({ types: ["text/plain"], text: "" })).toBeNull();
  });
});
