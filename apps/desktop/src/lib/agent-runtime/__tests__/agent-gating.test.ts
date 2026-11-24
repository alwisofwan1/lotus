import { describe, expect, it } from "vitest";

import { resolveRunnerCommand } from "@/lib/agent-runtime/agent-runner";
import { deriveGating } from "@/lib/agent-runtime/agent-gating";

describe("deriveGating", () => {
  describe("Claude-family runners", () => {
    it.each(["claude", "ccs", "csp"] as const)(
      "%s launched in safe mode asks permission per action",
      (runner) => {
        const command = resolveRunnerCommand(runner, undefined, "safe");

        expect(deriveGating(runner, command)).toBe("asks");
      },
    );

    it.each(["claude", "ccs", "csp"] as const)(
      "%s launched with full access skips the gate",
      (runner) => {
        const command = resolveRunnerCommand(runner, undefined, "full");

        expect(deriveGating(runner, command)).toBe("skipped");
      },
    );
  });

  describe("runners with no hook mechanism", () => {
    /**
     * Codex and Cursor never fire the agent-notify hook, so they cannot surface a
     * permission request to Pocket at all (ADR-8). That is a different fact from
     * "launched with the gate off", and the operator's fix differs: a Codex cell
     * can never gate, a Claude cell can be respawned.
     */
    it.each([
      ["codex", "safe"],
      ["codex", "full"],
      ["cursor", "safe"],
      ["cursor", "full"],
    ] as const)("%s in %s mode reports that the runner cannot gate", (runner, mode) => {
      const command = resolveRunnerCommand(runner, undefined, mode);

      expect(deriveGating(runner, command)).toBe("runner_cannot");
    });
  });

  describe("unknown rather than guessed", () => {
    it("returns undefined for a custom runner, whose command is arbitrary", () => {
      expect(deriveGating("custom", "my-agent --whatever")).toBeUndefined();
    });

    it("returns undefined when the command was never recorded", () => {
      expect(deriveGating("claude", undefined)).toBeUndefined();
    });

    it("returns undefined for an unrecognised runner", () => {
      // @ts-expect-error deliberately outside the union: the wire is untrusted.
      expect(deriveGating("gemini", "gemini --yolo")).toBeUndefined();
    });
  });

  describe("flag detection", () => {
    it("finds the flag wherever it sits in the command", () => {
      const command = resolveRunnerCommand("claude", undefined, "full", "--verbose", "s-1", "new");

      expect(command).toContain("--dangerously-skip-permissions");
      expect(deriveGating("claude", command)).toBe("skipped");
    });

    it("reports asks when only unrelated flags are present", () => {
      expect(deriveGating("claude", "claude --session-id s-1 --verbose")).toBe("asks");
    });

    /**
     * Matching is a plain substring search, and that is the right trade: if a
     * command is ambiguous, reading it as "skipped" under-claims protection.
     * The dangerous direction is the other one, telling the operator a cell will
     * ask before acting when it will not.
     */
    it("errs toward skipped rather than over-claiming protection", () => {
      expect(deriveGating("claude", "claude --dangerously-skip-permissions=maybe")).toBe("skipped");
    });
  });

  /**
   * The derivation reads the command that actually launched the process, so it
   * cannot disagree with reality the way a separate permissionMode field could.
   * These assertions fail if `resolveRunnerCommand` ever changes its flags.
   */
  describe("stays pinned to resolveRunnerCommand", () => {
    it.each(["claude", "ccs", "csp", "codex", "cursor"] as const)(
      "%s: safe and full modes derive to different gating",
      (runner) => {
        const safe = deriveGating(runner, resolveRunnerCommand(runner, undefined, "safe"));
        const full = deriveGating(runner, resolveRunnerCommand(runner, undefined, "full"));

        if (runner === "codex" || runner === "cursor") {
          expect(safe).toBe(full);
        } else {
          expect(safe).not.toBe(full);
        }
      },
    );
  });
});

/**
 * `deriveGating` reads the command that ran rather than a parallel field, so widening the
 * scale could have changed what it concludes without anyone touching it. It does not: the new
 * stops add `--permission-mode …`, which is not a skip flag.
 *
 * `acceptEdits` reading as `asks` is correct and worth stating: the cell writes files without
 * asking but still stops before running anything, and that stop reaches the phone as
 * `needs-input`. `asks` means *it can ask*, not *it asks about everything*.
 */
describe("gating across the permission scale", () => {
  it("reads every asking stop as asks, and only the ungated one as skipped", () => {
    for (const mode of ["safe", "manual", "plan", "acceptEdits"]) {
      expect(deriveGating("claude", resolveRunnerCommand("claude", undefined, mode)), mode).toBe("asks");
    }
    for (const mode of ["full", "yolo", "bypassPermissions"]) {
      expect(deriveGating("claude", resolveRunnerCommand("claude", undefined, mode)), mode).toBe("skipped");
    }
  });

  /**
   * Codex has no hooks, so no stop of its own can change this — the honest answer stays
   * `runner_cannot` even for `read-only`, which does ask. It asks the machine it runs on, and
   * a PTY Codex has no way to put that in front of a phone.
   */
  it("still says a hookless runner cannot gate, whatever stop it was given", () => {
    for (const mode of ["read-only", "auto", "full-access"]) {
      expect(deriveGating("codex", resolveRunnerCommand("codex", undefined, mode)), mode).toBe(
        "runner_cannot",
      );
    }
  });
});
