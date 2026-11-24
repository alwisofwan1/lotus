import { describe, expect, it } from "vitest";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { RemoteCapabilityProfile } from "@/lib/tauri/codespace-editor-ssh";
import {
  availableRunners,
  cliExecutable,
  clisOnMachine,
  hasNoRunners,
  runnerAvailability,
} from "../machine-runners";

const ALL: AgentRunnerType[] = ["claude", "ccs", "csp", "codex", "cursor", "custom"];

const profile = (runners: { id: string; version?: string }[]): RemoteCapabilityProfile => ({
  statVariant: "gnu",
  hasFd: false,
  hasRg: false,
  runners,
});

describe("which runners a machine can start", () => {
  /**
   * The distinction this whole service turns on: a machine we have not probed yet must not look
   * like a machine with nothing installed.
   */
  it("offers everything while the probe has not answered", () => {
    const rows = runnerAvailability(ALL, null);
    expect(rows.every((row) => row.available)).toBe(true);
    expect(rows.every((row) => row.reason === undefined)).toBe(true);
  });

  it("offers only what the machine actually has", () => {
    const rows = runnerAvailability(ALL, profile([{ id: "claude", version: "2.1.4" }]));
    expect(availableRunners(rows)).toEqual(["claude", "custom"]);
  });

  it("carries the version the machine reported", () => {
    const rows = runnerAvailability(["claude"], profile([{ id: "claude", version: "2.1.4" }]));
    expect(rows[0].version).toBe("2.1.4");
  });

  it("treats a runner that would not say its version as present anyway", () => {
    const rows = runnerAvailability(["codex"], profile([{ id: "codex" }]));
    expect(rows[0].available).toBe(true);
    expect(rows[0].version).toBeUndefined();
  });

  it("names the machine in the reason, so the sentence is about that host", () => {
    const rows = runnerAvailability(["codex"], profile([]), "devbox-vps");
    expect(rows[0].available).toBe(false);
    expect(rows[0].reason).toBe("Tidak ada di PATH devbox-vps");
  });

  it("looks for cursor under the executable it actually installs", () => {
    const rows = runnerAvailability(["cursor"], profile([{ id: "cursor-agent" }]));
    expect(rows[0].executable).toBe("cursor-agent");
    expect(rows[0].available).toBe(true);
  });

  it("never claims to have checked a custom runner", () => {
    const rows = runnerAvailability(["custom"], profile([]));
    expect(rows[0].available).toBe(true);
    expect(rows[0].reason).toBeUndefined();
  });

  it("treats the claude wrappers as separate executables", () => {
    const rows = runnerAvailability(["claude", "ccs", "csp"], profile([{ id: "ccs" }]));
    expect(availableRunners(rows)).toEqual(["ccs"]);
  });

  it("recognises a machine that can start nothing", () => {
    expect(hasNoRunners(runnerAvailability(["claude", "codex"], profile([])))).toBe(true);
    expect(hasNoRunners(runnerAvailability(["claude"], profile([{ id: "claude" }])))).toBe(false);
    expect(hasNoRunners([])).toBe(false);
  });
});

describe("the launch rows a machine can honour", () => {
  const clis = [
    { id: "claude", command: "claude" },
    { id: "codex", command: "codex" },
    { id: "ccs-work", command: "ccs work --yolo" },
  ];

  it("keeps every row while the machine has not been probed", () => {
    expect(clisOnMachine(clis, null)).toHaveLength(3);
    expect(clisOnMachine(clis, { statVariant: "gnu", hasFd: false, hasRg: false })).toHaveLength(3);
  });

  it("drops the rows the machine cannot start", () => {
    const kept = clisOnMachine(clis, profile([{ id: "claude" }]));
    expect(kept.map((cli) => cli.id)).toEqual(["claude"]);
  });

  it("matches a wrapper command on its first token, not the whole line", () => {
    const kept = clisOnMachine(clis, profile([{ id: "ccs" }]));
    expect(kept.map((cli) => cli.id)).toEqual(["ccs-work"]);
    expect(cliExecutable("  ccs work --yolo ")).toBe("ccs");
  });
});
