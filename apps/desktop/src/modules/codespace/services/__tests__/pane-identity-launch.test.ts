import { describe, expect, it } from "vitest";
import { buildPaneLaunchCommand } from "@/modules/codespace/services/pane-identity-launch";

/** The flag and the text that follows it, for a launch that carried an overlay. */
function overlay(argv: string[] | undefined): string | undefined {
  if (!argv) return undefined;
  const at = argv.indexOf("--append-system-prompt");
  return at === -1 ? undefined : argv[at + 1];
}

describe("buildPaneLaunchCommand", () => {
  /**
   * The whole point. `Milo` was drawn from the name pool, drawn in the header, and never reached
   * the CLI — so the agent answered "I'm Claude" to a pane the operator was reading as Milo.
   */
  it("tells a Claude-family agent the name Lotus gave it", () => {
    const argv = buildPaneLaunchCommand({
      agentCommand: "claude --dangerously-skip-permissions",
      agentName: "Milo",
    });

    expect(argv?.slice(0, 3)).toEqual([
      "claude",
      "--dangerously-skip-permissions",
      "--append-system-prompt",
    ]);
    expect(overlay(argv)).toContain("You are Milo,");
    // The workspace spelling, not the canvas one: a pane in a folder is not a board.
    expect(overlay(argv)).toContain("Lotus workspace");
    expect(overlay(argv)).not.toContain("Lotus canvas");
  });

  it("tells Pi its name at launch too, not in the conversation", () => {
    const argv = buildPaneLaunchCommand({ agentCommand: "pi", agentName: "Taro" });
    expect(argv?.slice(0, 2)).toEqual(["pi", "--append-system-prompt"]);
    expect(overlay(argv)).toContain("You are Taro,");
  });

  it("names the agents already open in the folder, and never the agent itself", () => {
    const text = overlay(
      buildPaneLaunchCommand({
        agentCommand: "claude",
        agentName: "Milo",
        roster: ["Nara", "milo", "Bima"],
      }),
    );

    expect(text).toContain("Nara");
    expect(text).toContain("Bima");
    expect(text).not.toMatch(/include[^.]*\bmilo\b/i);
  });

  /**
   * Only Claude-family CLIs take `--append-system-prompt`; the registry is what says so. Handing
   * the flag to `codex` would not make it introduce itself, it would make it refuse to start.
   */
  it("gives no overlay to a runner that does not accept one", () => {
    const argv = buildPaneLaunchCommand({ agentCommand: "codex", agentName: "Milo" });
    expect(argv).toEqual(["codex"]);
    expect(overlay(argv)).toBeUndefined();
  });

  it("gives no overlay to a plain shell, which has no agent to name", () => {
    expect(buildPaneLaunchCommand({ agentCommand: "zsh", agentName: "Milo" })).toEqual(["zsh"]);
    expect(buildPaneLaunchCommand({ agentCommand: "" })).toBeUndefined();
    expect(buildPaneLaunchCommand({})).toBeUndefined();
  });

  it("gives no overlay to a pane that was never named", () => {
    expect(buildPaneLaunchCommand({ agentCommand: "claude" })).toEqual(["claude"]);
  });

  /**
   * The behaviour this replaced, kept exactly: a single word ran directly, anything else went
   * through a shell. A command carrying shell syntax cannot be reproduced as argv, so it still
   * does — losing the overlay rather than launching something subtly different.
   */
  it("keeps the shell path for a command it cannot reproduce as argv", () => {
    expect(
      buildPaneLaunchCommand({ agentCommand: 'claude --model "opus 5"', agentName: "Milo" }),
    ).toBeUndefined();
  });
});
