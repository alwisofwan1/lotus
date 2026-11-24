import { describe, expect, it, vi } from "vitest";
import { buildSpawnFirstAgentDefinition, cliToRunnerSpec } from "../spawn-first-agent";
import { DEFAULT_AGENT_NAME_POOL } from "@/lib/agent-catalog";

describe("buildSpawnFirstAgentDefinition", () => {
  it("auto-names from the pool and sets the chosen runner", () => {
    const def = buildSpawnFirstAgentDefinition("codex", []);
    expect(def.name).toBe(DEFAULT_AGENT_NAME_POOL[0]);
    expect(def.runner).toBe("codex");
    expect(def.id).toBeTruthy();
  });

  it("skips taken names so the handle is unique per canvas (case-insensitive)", () => {
    const taken = [DEFAULT_AGENT_NAME_POOL[0].toLowerCase()];
    const def = buildSpawnFirstAgentDefinition("claude", taken);
    expect(def.name).toBe(DEFAULT_AGENT_NAME_POOL[1]);
  });

  it("produces a CNVS-pure definition: empty prompt AND empty model (ADR-0027)", () => {
    const def = buildSpawnFirstAgentDefinition("claude", []);
    expect(def.prompt).toBe("");
    expect(def.model).toBe(""); // no baked model — the CLI uses its own default
    expect(def.appliedSkills).toEqual([]);
  });

  it("gives each spawn a distinct id", () => {
    const a = buildSpawnFirstAgentDefinition("claude", []);
    const b = buildSpawnFirstAgentDefinition("claude", []);
    expect(a.id).not.toBe(b.id);
  });

  it("threads a custom runnerCommand for the custom runner (cursor)", () => {
    const def = buildSpawnFirstAgentDefinition("custom", [], { runnerCommand: "cursor-agent --yolo" });
    expect(def.runner).toBe("custom");
    expect(def.runnerCommand).toBe("cursor-agent --yolo");
  });

  // 03b: this is the single choke point every spawn-first call site funnels through — the
  // seven callers (TeamNode, CanvasPage, useCanvasTaskCommands, the voice/NL controllers,
  // command-sheet-items) all pass an UN-shuffled `pool`, so the shuffle has to happen here,
  // once, or spawn-first stays "always Atlas, Nova, Kai in order" regardless of slice 03.
  it("(03b) shuffles a given pool before it reaches nextAgentName", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const pool = ["Nara", "Bima", "Sena", "Bayu"];
      const def = buildSpawnFirstAgentDefinition("claude", [], { pool });
      // Fisher–Yates with rng() pinned to 0 is exercised precisely in shuffle.test.ts; the
      // point here is just that nextAgentName receives a DIFFERENT order than `pool` itself.
      expect(def.name).not.toBe(pool[0]);
      expect(pool).toEqual(["Nara", "Bima", "Sena", "Bayu"]); // the caller's array is untouched
    } finally {
      randomSpy.mockRestore();
    }
  });

  // opts.pool is optional; nextAgentName falls back to DEFAULT_AGENT_NAME_POOL when it's
  // omitted. That fallback must stay deterministic — this is the "no pool given" path, not the
  // "pool given" path above, so it must never be shuffled.
  it("(03b) leaves the omitted-pool (default) path exactly as before — not shuffled", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      const def = buildSpawnFirstAgentDefinition("claude", []);
      expect(def.name).toBe(DEFAULT_AGENT_NAME_POOL[0]);
    } finally {
      randomSpy.mockRestore();
    }
  });
});

describe("cliToRunnerSpec", () => {
  it("maps claude, codex, and cursor to their native runners (ADR-0027)", () => {
    expect(cliToRunnerSpec({ id: "claude", command: "claude --dangerously-skip-permissions" })).toEqual({ runner: "claude" });
    expect(cliToRunnerSpec({ id: "codex", command: "codex --dangerously-bypass-approvals-and-sandbox" })).toEqual({ runner: "codex" });
    expect(cliToRunnerSpec({ id: "cursor", command: "cursor-agent --yolo" })).toEqual({ runner: "cursor" });
  });

  it("maps any unknown CLI to the custom runner with its detected command", () => {
    expect(cliToRunnerSpec({ id: "aider", command: "aider --yes" })).toEqual({ runner: "custom", runnerCommand: "aider --yes" });
  });

  it("carries a permission mode through to the node, and omits it when none was asked", () => {
    // `resolveRunnerLaunch` lets a node's own mode beat the registry's `skip_permissions`,
    // so this field is where a phone's `safe` request actually lands. Omitting it must
    // leave the registry in charge — the behaviour every caller had before.
    const safe = buildSpawnFirstAgentDefinition("claude", [], { permissionMode: "safe" });
    expect(safe.permissionMode).toBe("safe");

    const unspecified = buildSpawnFirstAgentDefinition("claude", []);
    expect(unspecified.permissionMode).toBe("full");
  });
});
