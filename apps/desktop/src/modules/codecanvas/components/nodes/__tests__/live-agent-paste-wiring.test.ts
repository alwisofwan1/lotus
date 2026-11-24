import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Wiring guard for the paste-auto-submit fix (defense-in-depth half): LiveAgentNode must
 * intercept DOM paste ahead of xterm's own textarea handler and deliver the explicitly
 * bracket-wrapped bytes to the PTY. The behavior itself is covered by the planLiveAgentPaste
 * unit tests; this pins the component wiring, which has no cheap render harness (xterm + PTY).
 */
const source = readFileSync(
  join(__dirname, "..", "LiveAgentNode.tsx"),
  "utf8",
);

describe("LiveAgentNode paste wiring", () => {
  it("routes DOM paste through planLiveAgentPaste into the PTY", () => {
    expect(source).toContain("planLiveAgentPaste");
    // Capture phase, so it runs before xterm's textarea paste handler.
    expect(source).toMatch(/addEventListener\("paste",\s*\w+,\s*true\)/);
    expect(source).toMatch(/removeEventListener\("paste",\s*\w+,\s*true\)/);
  });

  it("claims the event only when a plan exists (images/empty text flow natively)", () => {
    const handler = source.slice(source.indexOf("planLiveAgentPaste("));
    expect(handler).toContain("preventDefault()");
    expect(handler).toContain("stopPropagation()");
  });
});
