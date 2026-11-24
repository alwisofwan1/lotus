import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  cleanTerminalLine,
  isPromptLike,
  isWorkingStatusLine,
  hasActiveWorkingStatusTail,
  hasAgentReadyOutput,
  isAgentReadyLine,
} from "../terminal-status-lines";

describe("terminal-status-lines", () => {
  it("strips ANSI escape sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b]0;title\x07plain")).toBe("plain");
  });

  it("cleans a terminal line down to printable text", () => {
    expect(cleanTerminalLine("\x1b[1m  hello   world \x07")).toBe("hello world");
  });

  it("recognises shell/agent prompt-like lines", () => {
    expect(isPromptLike("$")).toBe(true);
    expect(isPromptLike("esc to interrupt")).toBe(true);
    expect(isPromptLike("npm test")).toBe(false);
  });

  it("recognises agent working-status lines", () => {
    expect(isWorkingStatusLine("Working(esc to interrupt)")).toBe(true);
    expect(isWorkingStatusLine("working (12s)")).toBe(true);
    expect(isWorkingStatusLine("· Distilling… esc to interrupt")).toBe(true);
    expect(isWorkingStatusLine("just normal output")).toBe(false);
  });

  it("detects an active working tail across CR/LF repaints", () => {
    expect(hasActiveWorkingStatusTail("foo\r\nWorking(10s · esc to interrupt)")).toBe(true);
    expect(hasActiveWorkingStatusTail("Working…\r\n$ ")).toBe(false);
    expect(hasActiveWorkingStatusTail("")).toBe(false);
  });

  describe("hasAgentReadyOutput", () => {
    it("detects ►► prefix in the status bar tail (auto mode)", () => {
      const chunk = "Sonnet 4.6 | 5h: 0%\n►► auto mode on (shift+tab to cycle)\nClaude in Chrome enabled · /chrome";
      expect(hasAgentReadyOutput(chunk)).toBe(true);
    });

    it("detects ►► prefix (bypass mode)", () => {
      expect(hasAgentReadyOutput("Sonnet 4.6\n►► bypass mode on (shift+tab to cycle)")).toBe(true);
    });

    it("detects Claude standby when the terminal renders small chevrons", () => {
      expect(isAgentReadyLine("▸▸ auto mode on (shift+tab to cycle) · ← for agents")).toBe(true);
      expect(hasAgentReadyOutput("Sonnet 4.6\n▸▸ auto mode on (shift+tab to cycle) · ← for agents")).toBe(true);
    });

    it("detects Codex idle footer prompts", () => {
      expect(hasAgentReadyOutput("Done\ngpt-5.5 high · ~/workspace/repo")).toBe(true);
      expect(hasAgentReadyOutput("> Improve documentation\nctrl+c to exit · gpt-5.5 high · ~/repo")).toBe(true);
      expect(isAgentReadyLine("›")).toBe(true);
      expect(isAgentReadyLine("› ")).toBe(true);
    });

    it("does NOT treat Codex startup banners as ready", () => {
      expect(hasAgentReadyOutput("OpenAI Codex v1.2.3\nLoading session...")).toBe(false);
    });

    it("does NOT false-positive on response text mentioning 'auto mode on' mid-content", () => {
      const chunk = "The app supports auto mode on startup.\nYou can configure it in settings.";
      expect(hasAgentReadyOutput(chunk)).toBe(false);
    });

    it("does NOT false-positive on 'auto mode on' beyond last 4 lines", () => {
      const deep = "►► auto mode on\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6";
      expect(hasAgentReadyOutput(deep)).toBe(false);
    });

    it("does NOT match normal response content in the last 4 lines", () => {
      expect(hasAgentReadyOutput("- PostgreSQL (data utama)\n- Redis (cache)\n- Cloudflare R2\n(file/media)")).toBe(false);
    });

    it("does NOT match empty input", () => {
      expect(hasAgentReadyOutput("")).toBe(false);
    });
  });

  /**
   * Captured live on 2026-09-22 from pane `921f60b6`, while Rust reported `turn: running` for it.
   * These are the exact bytes the matchers get today; every one of them was classified wrongly
   * before, which is why a working agent showed a "ready" badge.
   */
  describe("Claude Code, as it actually prints today", () => {
    const SPINNER = "\u2733 Discombobulating\u2026 (2m 56s \u00b7 \u21938.4k tokens \u00b7 thought for 4s)";
    const SPINNER_WITH_HOOKS = "\u2736 Discombobulating\u2026 (running PreToolUse hooks\u2026 1/2 \u00b7 2m 56s \u00b7 \u21938.4k tokens)";
    const SPINNER_INTERRUPT = "\u273b Herding\u2026 (esc to interrupt)";
    const FOOTER_AUTO = "\u25ba\u25ba auto mode on (shift+tab to cycle) \u00b7 \u2190 1 agent";
    const FOOTER_BYPASS = "\u25ba\u25ba bypass permissions on (shift+tab to cycle) \u00b7 \u2190 1 agent";

    it("reads the spinner as working, with or without the interrupt hint", () => {
      expect(isWorkingStatusLine(SPINNER)).toBe(true);
      expect(isWorkingStatusLine(SPINNER_WITH_HOOKS)).toBe(true);
      // `(esc to interrupt)` has a bracket before `esc`, not a space.
      expect(isWorkingStatusLine(SPINNER_INTERRUPT)).toBe(true);
    });

    it("reads every mode footer as ready, not just the `auto` one", () => {
      expect(isAgentReadyLine(FOOTER_AUTO)).toBe(true);
      expect(isAgentReadyLine(FOOTER_BYPASS)).toBe(true);
      expect(isAgentReadyLine("\u23f5\u23f5 bypass permissions on (shift+tab to cycle)")).toBe(true);
    });

    it("finds the working line although the mode footer sits below it", () => {
      const repaint = [
        "\u23fa Reading ActivityBadge",
        "  \u23bf  $ cat -n src/modules/workspace-shell/components/ActivityBadge.tsx",
        SPINNER,
        "\ud83e\udd16 Opus 5 (1M context) | 0% resets 7:40PM",
        "\ud83d\udcc1 ~/workspace/experiments/Lotus",
        FOOTER_AUTO,
      ].join("\r\n");
      expect(hasActiveWorkingStatusTail(repaint)).toBe(true);
    });

    it("still calls a settled pane ready once the spinner is gone", () => {
      const settled = [
        "\u23fa Done.",
        "\ud83d\udcc1 ~/workspace/experiments/Lotus",
        FOOTER_AUTO,
      ].join("\r\n");
      expect(hasActiveWorkingStatusTail(settled)).toBe(false);
      expect(hasAgentReadyOutput(settled)).toBe(true);
    });

    it("does not call an ordinary elapsed-time line working", () => {
      expect(isWorkingStatusLine("Duration 40.55s (transform 10.41s)")).toBe(false);
      expect(isWorkingStatusLine("build finished in 12s")).toBe(false);
    });
  });
});
