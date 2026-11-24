import { describe, expect, it } from "vitest";

import { applyTuning, runnerTuningArgv } from "../agent-tuning";

/**
 * The second thing a spawn may fix for the life of a cell, after its posture: which
 * model, and how hard it thinks. Same shape of test as `permission-mode.test.ts`
 * because it is the same kind of decision — a process argument, chosen once.
 */
describe("runnerTuningArgv", () => {
  it("is empty when nothing was chosen — the CLI keeps its own defaults", () => {
    expect(runnerTuningArgv("claude", {})).toEqual([]);
    expect(runnerTuningArgv("codex", { model: "  ", effort: "" })).toEqual([]);
  });

  it("speaks Claude Code's flags for the claude family", () => {
    expect(runnerTuningArgv("claude", { model: "sonnet", effort: "high" })).toEqual([
      "--model", "sonnet", "--effort", "high",
    ]);
    expect(runnerTuningArgv("ccs-hss", { effort: "max" })).toEqual(["--effort", "max"]);
    expect(runnerTuningArgv("csp", { model: "opus" })).toEqual(["--model", "opus"]);
  });

  it("speaks codex-cli's flags for codex, with the effort as a TOML override", () => {
    expect(runnerTuningArgv("codex", { model: "gpt-5.4-codex", effort: "xhigh" })).toEqual([
      "-m", "gpt-5.4-codex", "-c", 'model_reasoning_effort="xhigh"',
    ]);
  });

  it("drops a tuning for a runner whose flags Lotus does not know, rather than guessing", () => {
    expect(runnerTuningArgv("cursor", { model: "x", effort: "high" })).toEqual([]);
    expect(runnerTuningArgv("gemini", { model: "x" })).toEqual([]);
  });

  it("lets the registry's claude-family flag win over an unfamiliar id", () => {
    expect(runnerTuningArgv("custom-acme", { model: "opus" }, true)).toEqual(["--model", "opus"]);
    expect(runnerTuningArgv("custom-acme", { model: "opus" })).toEqual([]);
  });
});

describe("applyTuning", () => {
  it("appends after whatever the posture left, never before", () => {
    expect(applyTuning(["claude", "--dangerously-skip-permissions"], "claude", { model: "haiku" })).toEqual([
      "claude", "--dangerously-skip-permissions", "--model", "haiku",
    ]);
  });

  it("does not mutate the command it was given", () => {
    const cmd = ["codex"];
    applyTuning(cmd, "codex", { effort: "low" });
    expect(cmd).toEqual(["codex"]);
  });
});

describe("effort values the CLI would reject", () => {
  it("carries a legacy 'minimal' to low instead of handing Claude a value it ignores", () => {
    // `claude --effort minimal` prints "Unknown --effort value" and uses the default, so the flag
    // was worse than useless: it looked set. Other surfaces (CodeChat settings, canvas team
    // templates) still store "minimal", and they all pass through here.
    expect(runnerTuningArgv("claude", { effort: "minimal" }, true)).toEqual(["--effort", "low"]);
  });

  it("passes a valid level through untouched, including xhigh", () => {
    expect(runnerTuningArgv("claude", { effort: "xhigh" }, true)).toEqual(["--effort", "xhigh"]);
  });

  it("still drops effort entirely for a runner with no such flag", () => {
    expect(runnerTuningArgv("cursor", { effort: "minimal" }, false)).toEqual([]);
  });
});
