import { describe, it, expect } from "vitest";
import {
  resolve,
  listProviders,
  listExecutors,
  listPlanners,
  isKnownProvider,
  UnknownProviderError,
  BUILTIN_ROLES,
  getRoleById,
  listRoles,
  findSpec,
  agentStartError,
  PICKER_AGENT_IDS,
} from "../agent-registry";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("agent-registry", () => {
  it("resolves claude-headless with stream-json args", () => {
    const spec = resolve("claude-headless");
    expect(spec.isHeadless).toBe(true);
    expect(spec.command[0]).toBe("claude");
    expect(spec.command).toContain("--print");
    expect(spec.command).toContain("--output-format");
    expect(spec.command).toContain("stream-json");
  });

  it("resolves codex-headless with JSONL exec args", () => {
    const spec = resolve("codex-headless");
    expect(spec.isHeadless).toBe(true);
    expect(spec.command.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(spec.command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(spec.command).toContain("--skip-git-repo-check");
  });

  it("claude-headless runs in YOLO mode (--dangerously-skip-permissions)", () => {
    const spec = resolve("claude-headless");
    expect(spec.command).toContain("--dangerously-skip-permissions");
  });

  it("claude-headless requests token-by-token streaming via --include-partial-messages", () => {
    const spec = resolve("claude-headless");
    expect(spec.command).toContain("--include-partial-messages");
  });

  it("ccs-hss-headless also requests token-by-token streaming via --include-partial-messages", () => {
    // ccs hss is a wrapper around `claude` and forwards CLI flags through.
    // Without the flag here, users on this provider see the legacy flash UX.
    const spec = resolve("ccs-hss-headless");
    expect(spec.command).toContain("--include-partial-messages");
  });

  it("resolves all executor providers as non-headless", () => {
    for (const id of ["claude", "codex", "gemini", "opencode", "cursor", "copilot", "ccs-hss"] as const) {
      const spec = resolve(id);
      expect(spec.id).toBe(id);
      expect(spec.isHeadless).toBe(false);
      expect(spec.command.length).toBeGreaterThan(0);
    }
  });

  it("throws UnknownProviderError for unknown id", () => {
    // deliberately cast — runtime check
    expect(() => resolve("bogus" as never)).toThrow(UnknownProviderError);
  });

  it("lists providers grouped by role", () => {
    expect(listProviders().length).toBe(15);
    expect(listExecutors().length).toBe(12);
    expect(listPlanners().length).toBe(3);
    expect(listPlanners()[0].id).toBe("claude-headless");
  });

  it("narrows provider id via isKnownProvider", () => {
    expect(isKnownProvider("claude")).toBe(true);
    expect(isKnownProvider("claude-headless")).toBe(true);
    expect(isKnownProvider("ccs-hss")).toBe(true);
    expect(isKnownProvider("ccs-hss-headless")).toBe(true);
    expect(isKnownProvider("codex-headless")).toBe(true);
    expect(isKnownProvider("nope")).toBe(false);
  });

  it("names the agent whose start error the output holds, through colour codes", () => {
    // Seen live 2026-11-20: cursor-agent on a Free plan with a model the plan lacks.
    expect(agentStartError("\x1b[31mError: Model unavailable on Free\x1b[0m\nFree includes Grok 4.7")).toBe("cursor");
    expect(agentStartError("Error: something else")).toBe(null);
  });

  it("launches the standalone copilot CLI, as cli_detect.rs looks for it", () => {
    expect(resolve("copilot").command).toEqual(["copilot"]);
  });

  // agents.json is the one list of agents (Rust embeds it too): each must resolve here, as an
  // interactive spec with artwork that exists, or a pane falls back to a guess.
  it("resolves every agent in agents.json, each with a logo on disk", () => {
    expect(PICKER_AGENT_IDS.length).toBeGreaterThanOrEqual(11);
    for (const id of PICKER_AGENT_IDS) {
      const spec = findSpec(id);
      expect(spec, id).toBeDefined();
      expect(spec?.isHeadless, id).toBe(false);
      expect(existsSync(join(process.cwd(), "public", spec?.logo ?? "missing")), `${id} logo`).toBe(true);
    }
  });

  it("uses ccs hss as a two-token executor and planner profile", () => {
    expect(resolve("ccs-hss").command).toEqual(["ccs", "hss"]);
    expect(resolve("ccs-hss-headless").command.slice(0, 2)).toEqual(["ccs", "hss"]);
    expect(resolve("ccs-hss-headless").command).toContain("stream-json");
  });
});

describe("BUILTIN_ROLES", () => {
  const expectedIds = ["orchestrator", "planner", "implementer", "reviewer", "tester", "refactor"] as const;

  it("ships the built-in roles", () => {
    expect(BUILTIN_ROLES).toHaveLength(6);
    expect(BUILTIN_ROLES.map((r) => r.id).sort()).toEqual([...expectedIds].sort());
  });

  it("includes an orchestrator role that delegates via the lotus_* fleet tools", () => {
    const orchestrator = BUILTIN_ROLES.find((r) => r.id === "orchestrator");
    expect(orchestrator?.systemPromptAddon).toMatch(/lotus_spawn_cell/);
    expect(orchestrator?.systemPromptAddon).toMatch(/lotus_gather_results/);
  });

  it("each role has a substantial system prompt addon", () => {
    for (const role of BUILTIN_ROLES) {
      const wordCount = role.systemPromptAddon.trim().split(/\s+/).length;
      expect(wordCount, `role ${role.id} addon too short`).toBeGreaterThanOrEqual(20);
      expect(role.label.length).toBeGreaterThan(0);
      expect(role.description.length).toBeGreaterThan(0);
    }
  });

  it("reviewer role forbids file edits", () => {
    const reviewer = BUILTIN_ROLES.find((r) => r.id === "reviewer");
    expect(reviewer?.systemPromptAddon).toMatch(/never edit files/i);
  });

  it("tester role forbids editing production code", () => {
    const tester = BUILTIN_ROLES.find((r) => r.id === "tester");
    expect(tester?.systemPromptAddon).toMatch(/never edit production code/i);
  });

  it("refactor role requires behavior preservation", () => {
    const refactor = BUILTIN_ROLES.find((r) => r.id === "refactor");
    expect(refactor?.systemPromptAddon).toMatch(/behavior must not change/i);
  });

  it("getRoleById returns the matching role or undefined", () => {
    expect(getRoleById("reviewer")?.label).toBe("Reviewer");
    expect(getRoleById("nope")).toBeUndefined();
    expect(getRoleById(undefined)).toBeUndefined();
    expect(getRoleById("")).toBeUndefined();
  });

  it("listRoles returns the same data as BUILTIN_ROLES", () => {
    expect(listRoles()).toEqual(BUILTIN_ROLES);
  });
});
