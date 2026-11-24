import { describe, expect, it } from "vitest";
import { paneRunnerIdentity } from "@/modules/workspace-shell/services/pane-runner-identity";
import type { GridCell } from "@/modules/codespace/components/types";

const terminal: GridCell = { id: "t1", cwd: "/Users/me/lotus", type: "terminal" };

describe("paneRunnerIdentity", () => {
  it("names a runner from the registry, never from a table of its own", () => {
    expect(paneRunnerIdentity({ ...terminal, agentCommand: "claude" })).toEqual({
      provider: "claude",
      label: "Claude",
      mark: { kind: "logo", src: "/assets/ai-logo/Claude.svg" },
    });
  });

  /**
   * The bug this inherits the fix for: a pane opened as a plain shell that the operator then typed
   * `claude` into. `runtimeProvider` is what `fleet-output-tap` read from the CLI's own banner, and
   * it has to win — otherwise the header calls it a shell while the fleet calls it `claude-2`.
   */
  it("believes what is RUNNING over what the pane was launched with", () => {
    const handedOver: GridCell = { ...terminal, agentCommand: "", runtimeProvider: "claude" };
    expect(paneRunnerIdentity(handedOver)?.provider).toBe("claude");

    const swapped: GridCell = { ...terminal, agentCommand: "claude", runtimeProvider: "codex" };
    expect(paneRunnerIdentity(swapped)).toMatchObject({
      provider: "codex",
      mark: { kind: "logo", src: "/assets/ai-logo/ChatGPT.svg" },
    });
  });

  it("gives copilot and droid their own marks, read from the registry", () => {
    expect(paneRunnerIdentity({ ...terminal, agentCommand: "copilot" })).toEqual({
      provider: "copilot",
      label: "Copilot",
      mark: { kind: "logo", src: "/assets/ai-logo/Copilot.svg" },
    });
    expect(paneRunnerIdentity({ ...terminal, agentCommand: "droid" })?.mark).toEqual({ kind: "logo", src: "/assets/ai-logo/Droid.svg" });
  });

  /**
   * A shell is a shell. Marking it with a robot would claim an agent that is not there, and the
   * header falls back to its kind glyph — which is the truth.
   */
  it("says nothing about a plain shell", () => {
    expect(paneRunnerIdentity(terminal)).toBeUndefined();
    expect(paneRunnerIdentity({ ...terminal, agentCommand: "zsh" })).toBeUndefined();
  });

  it("says nothing about a pane that runs no process at all", () => {
    expect(paneRunnerIdentity({ id: "b1", cwd: "/x", type: "browser", url: "https://x" })).toBeUndefined();
  });
});
