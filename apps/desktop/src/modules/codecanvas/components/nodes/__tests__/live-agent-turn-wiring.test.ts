import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Wiring guard for the agent-done notify fix (turn-gating + runner hook coverage): LiveAgentNode
 * must (1) feed every byte written to its PTY through the pane turn registry, so the idle-fallback
 * callout only ever announces after a real submit, (2) publish `hookCapable` to the status
 * registry so claude/codex panes are never byte-guessed, and (3) drop the pane's turn state on
 * unmount. The behaviors are covered by pane-turn-registry / agent-done-callout unit tests; this
 * pins the component wiring, which has no cheap render harness (xterm + PTY).
 */
const source = readFileSync(join(__dirname, "..", "LiveAgentNode.tsx"), "utf8");

describe("LiveAgentNode turn wiring", () => {
  it("routes every PTY write through the pane turn registry", () => {
    expect(source).toContain("paneTurnRegistry.noteInput(");
  });

  it("forwards PTY output into voice turn first-output correlation", () => {
    expect(source).toContain("voiceAgentOutputCorrelationRegistry.noteOutput(");
  });

  it("publishes hookCapable derived from the runner type + claude_family flag", () => {
    expect(source).toContain("isHookCapableRunner(");
    expect(source).toMatch(/hookCapable/);
  });

  it("clears the pane's turn state when the node unmounts", () => {
    expect(source).toContain("paneTurnRegistry.clear(");
  });
});
