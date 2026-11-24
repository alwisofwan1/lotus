import { describe, it, expect } from "vitest";
import { localizeConfirmation } from "../localize-confirmation";
import { summarizeResolutions, type NlResolution, type SpokenAction } from "../../canvas-nl-command";

/** Minimal resolution: only the fields the confirmation channel reads. */
function res(opts: { spoken?: SpokenAction; speak?: string; group?: { verb: string; noun: string } }): NlResolution {
  return {
    effect: { kind: "dispatch", agentId: "x", text: "y" },
    destructive: false,
    summary: "",
    speak: opts.speak ?? "",
    ...(opts.spoken ? { spoken: opts.spoken } : {}),
    ...(opts.group ? { group: opts.group } : {}),
  };
}

const spawn = (runner: string): NlResolution =>
  res({ spoken: { kind: "spawn", runner }, group: { verb: "Spawning", noun: `${runner} agent` } });

describe("localizeConfirmation — English stays canonical", () => {
  it("delegates to summarizeResolutions verbatim for English (zero regression)", () => {
    const batch = [spawn("Claude"), spawn("Claude"), spawn("Codex")];
    expect(localizeConfirmation(batch, "en")).toBe(summarizeResolutions(batch).speak);
    // And that canonical output is the expected counted phrase.
    expect(localizeConfirmation(batch, "en")).toBe("Spawning 2 Claude agents and a Codex agent");
  });
});

describe("localizeConfirmation — Japanese", () => {
  it("renders single actions with kana/kanji and no trailing separators", () => {
    expect(localizeConfirmation([res({ spoken: { kind: "focus", target: "Rowan" } })], "ja")).toBe(
      "Rowanにフォーカスしました。",
    );
    expect(localizeConfirmation([res({ spoken: { kind: "close_all" } })], "ja")).toBe("すべて閉じました。");
  });

  it("counts spawns and concatenates sentences with no space", () => {
    const batch = [spawn("Claude"), spawn("Claude"), spawn("Claude")];
    expect(localizeConfirmation(batch, "ja")).toBe("Claudeエージェントを3つ用意しました。");
    const two = [spawn("Claude"), res({ spoken: { kind: "arrange" } })];
    expect(localizeConfirmation(two, "ja")).toBe("Claudeエージェントを用意しました。キャンバスを整えました。");
  });

  it("coalesces two runners and carries run_task team mode", () => {
    const batch = [spawn("Claude"), spawn("Claude"), spawn("Codex")];
    expect(localizeConfirmation(batch, "ja")).toBe("Claudeエージェントを2つ、Codexエージェントを用意しました。");
    expect(localizeConfirmation([res({ spoken: { kind: "run_task", target: "Deploy", team: true } })], "ja")).toBe(
      "Deployのタスクを実行しました（チームで）。",
    );
  });
});

describe("localizeConfirmation — defensive fallback", () => {
  it("falls back to the English canonical when any resolution lacks a descriptor", () => {
    // A grouped resolution with NO `spoken` (e.g. an intent added without a mapping).
    const batch = [res({ group: { verb: "Spawning", noun: "Claude agent" }, speak: "Spawning a Claude agent" })];
    expect(localizeConfirmation(batch, "ja")).toBe(summarizeResolutions(batch).speak);
  });
});
