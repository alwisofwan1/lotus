import { describe, expect, it } from "vitest";
import {
  isUnusableTerminalPaneTitle,
  paneTitleSaysNothing,
  titleIsAssistantChatter,
  titleEchoesLaunchCommand,
} from "@/modules/codespace/services/pane-title/pane-title-normalizer";

describe("answers about the transcript are not titles", () => {
  // Seen live on 2026-09-21: this exact string was written to the rail as a pane's name.
  it("rejects the phrasing that reached the rail", () => {
    expect(isUnusableTerminalPaneTitle("Transcript not readable")).toBe(true);
  });

  it("still rejects the phrasings that were already known", () => {
    expect(isUnusableTerminalPaneTitle("Unreadable transcript")).toBe(true);
    expect(isUnusableTerminalPaneTitle("No output")).toBe(true);
  });

  it("keeps a real title that merely mentions a transcript", () => {
    expect(isUnusableTerminalPaneTitle("Parse the codex transcript format")).toBe(false);
  });
});

// 243 sidecar titles recorded 2026-09-21..10-10: "You've hit your weekly limit" named seven panes.
describe("a CLI error is not a title", () => {
  it("rejects the errors the title CLI printed instead of a title", () => {
    for (const title of [
      "You've hit your weekly limit",
      "Claude usage limit reached",
      "Rate limit exceeded",
      "Not logged in · Please run /login",
      "Invalid API key",
      "API Error: 529 Overloaded",
      "Credit balance is too low",
    ]) {
      expect(isUnusableTerminalPaneTitle(title), title).toBe(true);
    }
  });

  it("keeps a task that is about limits", () => {
    expect(isUnusableTerminalPaneTitle("Add rate limiting to the API")).toBe(false);
  });
});

// Claude's own titles, read from 623 real sessions 2026-10-10: most name the task, these do not.
describe("a title that names no task", () => {
  it("rejects a bare ticket code, a go-ahead and a launch flag", () => {
    for (const title of [
      "LOT2-74",
      "TKT-1071",
      "Mulai kerjakan sekarang",
      "Oke kirim sekarang",
      "Gunakan opsi A",
      "Oke kandidat 1",
      "New session",
      "Dangerously-skip-permissions",
      "Continue now",
    ]) {
      expect(paneTitleSaysNothing(title), title).toBe(true);
    }
  });

  it("keeps titles that carry a task, even short ones", () => {
    for (const title of ["LOT2-100 implementation", "TKT-1071 Acceptance Criteria", "Buat pantun", "Build APK terbaru", "Pull origin main"]) {
      expect(paneTitleSaysNothing(title), title).toBe(false);
    }
  });
});

describe("a title that only says how the agent was launched", () => {
  // Seen in the rail on 2026-09-21, beside panes that WERE doing real work.
  it("rejects a fragment of the command line", () => {
    expect(
      titleEchoesLaunchCommand("Dangerously skip permissions", "claude --dangerously-skip-permissions"),
    ).toBe(true);
  });

  it("rejects the command itself", () => {
    expect(titleEchoesLaunchCommand("Codex exec", "codex exec")).toBe(true);
  });

  it("keeps a real title from a pane launched with flags", () => {
    expect(
      titleEchoesLaunchCommand("Fix the flaky login test", "claude --dangerously-skip-permissions"),
    ).toBe(false);
  });

  it("has no opinion when there is no command to compare against", () => {
    expect(titleEchoesLaunchCommand("Anything", "")).toBe(false);
    expect(titleEchoesLaunchCommand("", "claude")).toBe(false);
  });
});

describe("paneTitleSaysNothing", () => {
  /*
    The one rule three readers share: the rail hides such a name, the fleet does not publish it to
    other agents or to the phone, and the refine pass is allowed to replace it. It lived in the
    rail alone until 2026-09-21, which is how "Transcript not readable" was being advertised to
    every peer while the rail itself had stopped showing it.
  */
  const context = { agentCommand: "claude --dangerously-skip-permissions", cwd: "/tmp/project" };

  it("refuses an answer about the transcript", () => {
    expect(paneTitleSaysNothing("Transcript not readable", context)).toBe(true);
  });

  it("refuses a name that is only the launch command", () => {
    expect(paneTitleSaysNothing("Dangerously skip permissions", context)).toBe(true);
  });

  it("refuses a name that only repeats the folder", () => {
    expect(paneTitleSaysNothing("project", context)).toBe(true);
  });

  it("refuses a name that only repeats the agent's own name", () => {
    expect(paneTitleSaysNothing("Faye", { ...context, agentName: "Faye" })).toBe(true);
  });

  it("keeps a real name", () => {
    expect(paneTitleSaysNothing("Fix the flaky login test", context)).toBe(false);
  });

  it("has no opinion about a pane with no name", () => {
    expect(paneTitleSaysNothing("", context)).toBe(false);
    expect(paneTitleSaysNothing(undefined)).toBe(false);
  });
});

describe("titleIsAssistantChatter", () => {
  it("refuses an assistant greeting or offer as a title (codex pane, 2026-10-14)", () => {
    for (const title of [
      "I'm ready to help with your coding project! Ple…",
      "Hello! How can I help you today?",
      "Sure, let me take a look",
      "What would you like me to do",
      "Can you share the failing test?",
    ]) {
      expect(titleIsAssistantChatter(title), title).toBe(true);
      expect(paneTitleSaysNothing(title), title).toBe(true);
    }
  });

  it("keeps real titles, questions about the work included", () => {
    for (const title of ["Fix the flaky login test", "Why does the build fail?", "Imagery pipeline cleanup", "Help page copy"]) {
      expect(titleIsAssistantChatter(title), title).toBe(false);
    }
  });
});

