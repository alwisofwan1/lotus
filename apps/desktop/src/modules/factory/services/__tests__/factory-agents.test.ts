import { describe, expect, it } from "vitest";
import type { FactoryAgentDefinition, FactoryCatalog, FactoryDefinitionView } from "@/lib/tauri/graph-run";
import {
  editOf,
  filterServers,
  filterSkills,
  foldNames,
  isUnpushed,
  kitMissing,
  kitRefusal,
  missingNames,
  modelLabel,
  summarizeNote,
  roleKit,
  sameEdit,
  toggled,
  unpushedLine,
} from "../factory-agents";

const agent = (over: Partial<FactoryAgentDefinition> = {}): FactoryAgentDefinition => ({
  role: "spec",
  preset: null,
  model: null,
  sameModel: false,
  skills: [],
  mcp: [],
  access: "read-only",
  timeoutMinutes: null,
  maxQuestions: null,
  prompt: "Write the spec.",
  source: null,
  ...over,
});

const catalog: FactoryCatalog = {
  skills: [
    { id: "tdd", source: "user", description: "Red, green, refactor" },
    { id: "domain", source: "repo", description: "The glossary" },
    { id: "notion:read", source: "plugin", description: null },
  ],
  mcp: [{ name: "context7", scope: "user", transport: "stdio", target: "npx" }],
  notes: [],
};

const view = (unpushed: FactoryDefinitionView["unpushed"]): FactoryDefinitionView => ({
  base: "main",
  baseFromFile: false,
  origin: { definition: null, error: null },
  local: { definition: null, error: null },
  unpushed,
  builtInPrompts: { triage: "", spec: "", implement: "", review: "", handoff: "" },
  notes: [],
  private: null,
});

describe("factory-agents", () => {
  it("names who picks the model when a role has no preset", () => {
    expect(modelLabel(agent({ role: "implement" }), [])).toBe("Run's choice");
    expect(modelLabel(agent(), [])).toBe("Same as implementer");
    expect(modelLabel(agent({ preset: "p1" }), [{ id: "p1", name: "Opus" }])).toBe("Opus");
    expect(modelLabel(agent({ preset: "gone" }), [])).toBe("gone");
    expect(modelLabel(agent({ preset: "p1", model: "sonnet" }), [{ id: "p1", name: "Opus" }])).toBe("Opus · sonnet");
    expect(modelLabel(agent({ model: "opus" }), [])).toBe("Same as implementer · opus");
  });

  it("finds a role's file, or factory.toml, among the unpushed files", () => {
    const v = view([{ path: ".lotus/factory/agents/spec.md", state: "added" }]);
    expect(isUnpushed(v, "spec")).toBe(true);
    expect(isUnpushed(v, "triage")).toBe(false);
    expect(isUnpushed(v, null)).toBe(false);
    expect(isUnpushed(view([{ path: ".lotus/factory.toml", state: "changed" }]), null)).toBe(true);
    expect(unpushedLine(v)).toBe("1 file not pushed");
    expect(unpushedLine(view([]))).toBeNull();
  });

  it("lists the names this Mac lacks, and none before the catalog loads", () => {
    expect(missingNames(["tdd", "ghost"], "skills", catalog)).toEqual(["ghost"]);
    expect(missingNames(["context7", "linear"], "mcp", catalog)).toEqual(["linear"]);
    expect(missingNames(["ghost"], "skills", null)).toEqual([]);
  });

  it("filters skills by text and source, servers by name or target", () => {
    expect(filterSkills(catalog, "GLOSS", "all").map((s) => s.id)).toEqual(["domain"]);
    expect(filterSkills(catalog, "", "plugin").map((s) => s.id)).toEqual(["notion:read"]);
    expect(filterSkills(catalog, "tdd", "repo")).toEqual([]);
    expect(filterServers(catalog, "npx").map((m) => m.name)).toEqual(["context7"]);
  });

  it("compares edits by value, ignoring the prompt's outer whitespace", () => {
    const a = editOf(agent({ skills: ["tdd"] }));
    expect(sameEdit(a, { ...a, prompt: "  Write the spec.\n" })).toBe(true);
    expect(sameEdit(a, { ...a, skills: ["tdd", "domain"] })).toBe(false);
    expect(sameEdit(a, { ...a, timeoutMinutes: 30 })).toBe(false);
  });

  it("gives a run Every agent's names first, then the role's own, each once (kit.rs wanted())", () => {
    const kit = roleKit("spec", { skills: ["domain"], mcp: ["context7"] }, { skills: ["tdd", "domain"], mcp: ["linear"] }, catalog);
    expect(kit.skills.map((n) => [n.name, n.shared, n.missing])).toEqual([["domain", true, false], ["tdd", false, false]]);
    expect(kit.mcp.map((n) => [n.name, n.shared, n.missing])).toEqual([["context7", true, false], ["linear", false, true]]);
    expect(kitMissing(kit)).toBe(1);
  });

  it("gives triage no MCP server, not even the shared ones, and flags nothing before the catalog loads", () => {
    const kit = roleKit("triage", { skills: [], mcp: ["context7"] }, { skills: ["ghost"], mcp: ["linear"] }, null);
    expect(kit.mcp).toEqual([]);
    expect(kit.noMcp).toBe(true);
    expect(kitMissing(kit)).toBe(0);
    expect(kitRefusal("triage", kit)).toBeNull();
  });

  it("words a refusal the way the runner does", () => {
    const kit = roleKit("spec", { skills: [], mcp: [] }, { skills: ["ghost"], mcp: ["linear"] }, catalog);
    expect(kitRefusal("spec", kit)).toBe('the spec agent needs what this Mac no longer has: skill "ghost", MCP server "linear"');
  });

  it("folds past five names into a count, and never folds a missing one away", () => {
    const names = (list: string[], gone: string[] = []) => list.map((name) => ({ name, shared: false, missing: gone.includes(name) }));
    expect(foldNames(names(["a", "b", "c", "d", "e"]))).toMatchObject({ hidden: 0 });
    const nine = names(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    expect(foldNames(nine).shown.map((n) => n.name)).toEqual(["a", "b", "c", "d", "e"]);
    expect(foldNames(nine).hidden).toBe(4);
    const hiddenOne = foldNames(names(["a", "b", "c", "d", "e", "f", "g"], ["g"]));
    expect(hiddenOne.shown.map((n) => n.name)).toEqual(["a", "b", "c", "d", "g"]);
    expect(hiddenOne.hidden).toBe(2);
  });

  it("toggles a name", () => {
    expect(toggled(["a"], "b")).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("summarizeNote", () => {
  it("keeps the first sentence as the summary and the whole text as the detail", () => {
    const note = "Matt Pocock is enabled but has no applicable installation. Install for this project or user scope.";
    expect(summarizeNote(note)).toMatchObject({ summary: "Matt Pocock is enabled but has no applicable installation.", detail: note });
  });

  it("names a plugin and drops it from the sentence", () => {
    const { title, summary } = summarizeNote("Plugin tools@market is enabled but disabled here. Do x.");
    expect(title).toBe("tools@market");
    expect(summary).toBe("Is enabled but disabled here.");
  });
});
