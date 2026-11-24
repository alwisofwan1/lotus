import { describe, expect, it } from "vitest";

import { applyPermissionMode, deriveGating } from "../agent-gating";

/**
 * The one moment a cell's permission posture can be chosen at all.
 *
 * ADR-8 (`plans/lotus-pocket`) accepts that a running cell cannot be turned back,
 * because `--dangerously-skip-permissions` is a process argument. Everything here is
 * about making the spawn honour what was asked, and `deriveGating` reading the same
 * command back is the check that the two halves agree.
 */
describe("applyPermissionMode", () => {
  it("leaves a bare interactive command alone in safe mode", () => {
    expect(applyPermissionMode(["claude"], "claude", "safe")).toEqual(["claude"]);
  });

  it("adds the runner's own opt-out flag in yolo mode", () => {
    expect(applyPermissionMode(["claude"], "claude", "yolo")).toEqual([
      "claude",
      "--dangerously-skip-permissions",
    ]);
    expect(applyPermissionMode(["codex"], "codex", "yolo")).toEqual([
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(applyPermissionMode(["gemini"], "gemini", "yolo")).toEqual(["gemini", "--yolo"]);
  });

  /**
   * The case that makes safe mode mean something: a preset that already opted out.
   * Merely *not adding* a flag would leave the cell ungated while the operator was
   * told it would ask.
   */
  it("strips an inherited opt-out when safe is asked for", () => {
    expect(
      applyPermissionMode(["claude", "--dangerously-skip-permissions"], "claude", "safe"),
    ).toEqual(["claude"]);
  });

  it("does not double up a flag the command already carried", () => {
    expect(
      applyPermissionMode(["claude", "--dangerously-skip-permissions"], "claude", "yolo"),
    ).toEqual(["claude", "--dangerously-skip-permissions"]);
  });

  it("answers the same for the CodeSpace and canvas spellings of one runner", () => {
    expect(applyPermissionMode(["ccs", "hss"], "ccs-hss", "yolo")).toEqual([
      "ccs",
      "hss",
      "--dangerously-skip-permissions",
    ]);
  });

  /** A runner with no flag is returned untouched — it can never ask, and never will. */
  it("returns a hookless runner's command unchanged", () => {
    expect(applyPermissionMode(["cursor"], "cursor", "yolo")).toEqual(["cursor"]);
  });

  it("produces commands that gating reads back the way they were asked for", () => {
    const safe = applyPermissionMode(["claude"], "claude", "safe").join(" ");
    const yolo = applyPermissionMode(["claude"], "claude", "yolo").join(" ");

    expect(deriveGating("claude", safe)).toBe("asks");
    expect(deriveGating("claude", yolo)).toBe("skipped");
  });
});
