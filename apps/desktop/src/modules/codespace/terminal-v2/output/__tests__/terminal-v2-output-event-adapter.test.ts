import { describe, expect, it } from "vitest";
import { processTerminalV2OutputEvent } from "../terminal-v2-output-event-adapter";

const baseInput = {
  data: "hello",
  paneRuntimeState: "ready_visible",
  trustPromptSeen: false,
  cwd: "/repo",
  cwdTrusted: false,
  hasActiveSuggestionRemainder: false,
} as const;

describe("processTerminalV2OutputEvent", () => {
  it("turns session-ended markers into exit effects without renderer writes", () => {
    const result = processTerminalV2OutputEvent({
      ...baseInput,
      data: "\r\n[Session ended:1]",
    });

    expect(result.exitCode).toBe(1);
    expect(result.outputRoute).toBe("none");
    expect(result.visibleData).toBe("");
  });

  it("preserves ordinary output containing a literal session-ended marker", () => {
    const data = "example [Session ended:0]\r\nmore output";
    const result = processTerminalV2OutputEvent({ ...baseInput, data });
    expect(result.exitCode).toBeNull();
    expect(result.visibleData).toBe(data);
    expect(result.outputRoute).toBe("visible");
  });

  it("strips cwd OSC updates from visible output", () => {
    const result = processTerminalV2OutputEvent({
      ...baseInput,
      data: "before\x1b]777;lotus-cwd=/repo/app\x07after",
    });

    expect(result.visibleData).toBe("beforeafter");
    expect(result.cwdUpdates).toEqual(["/repo/app"]);
    expect(result.outputRoute).toBe("visible");
  });

  it("extracts OSC 133 command boundaries while preserving clean visible output", () => {
    const result = processTerminalV2OutputEvent({
      ...baseInput,
      data: "run\x1b]133;C\x07done\x1b]133;D;0\x07",
    });

    expect(result.visibleData).toBe("rundone");
    expect(result.osc133Events).toEqual([
      { kind: "command-begin" },
      { kind: "command-end", exitCode: 0 },
    ]);
  });

  it("routes hidden pane output to the hidden buffer", () => {
    const result = processTerminalV2OutputEvent({
      ...baseInput,
      paneRuntimeState: "ready_hidden",
      data: "background output",
    });

    expect(result.outputRoute).toBe("hidden");
    expect(result.visibleData).toBe("background output");
  });

  it("detects trusted-folder prompts and confirmation output", () => {
    const prompt = processTerminalV2OutputEvent({
      ...baseInput,
      data: "Do you trust this folder?",
      cwdTrusted: true,
    });
    const confirmed = processTerminalV2OutputEvent({
      ...baseInput,
      data: "I trust this folder",
    });

    expect(prompt.nextTrustPromptSeen).toBe(true);
    expect(prompt.autoTrustResponse).toBe("1\r");
    expect(confirmed.rememberTrustedCwd).toBe(true);
    expect(confirmed.resizeAfterTrust).toBe(true);
  });

  it("schedules suggestion layout only for visible output with active suggestion remainder", () => {
    const visible = processTerminalV2OutputEvent({
      ...baseInput,
      hasActiveSuggestionRemainder: true,
    });
    const hidden = processTerminalV2OutputEvent({
      ...baseInput,
      paneRuntimeState: "ready_hidden",
      hasActiveSuggestionRemainder: true,
    });

    expect(visible.scheduleSuggestionLayout).toBe(true);
    expect(hidden.scheduleSuggestionLayout).toBe(false);
  });
});
