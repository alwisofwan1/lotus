import { describe, expect, it } from "vitest";
import { buildAgentRunPrompt } from "../agent-run-prompt";

describe("buildAgentRunPrompt", () => {
  it("always prepends the headless one-shot operating contract", () => {
    const prompt = buildAgentRunPrompt({ rolePrompt: "You are the Tech Lead." });
    expect(prompt).toContain("headless agent");
    expect(prompt).toContain("Do NOT ask for clarification");
    expect(prompt).toContain("You are the Tech Lead.");
  });

  it("emits the live interactive contract for a live agent, not the headless one-shot one", () => {
    const prompt = buildAgentRunPrompt({ rolePrompt: "ROLE", operatingMode: "live" });
    expect(prompt).toContain("live agent");
    expect(prompt).toContain("A human is watching");
    expect(prompt).toContain("clarifying question");
    expect(prompt).not.toContain("Do NOT ask for clarification");
  });

  it("defaults to the headless contract and treats explicit headless identically (back-compat)", () => {
    const def = buildAgentRunPrompt({ rolePrompt: "ROLE" });
    const explicit = buildAgentRunPrompt({ rolePrompt: "ROLE", operatingMode: "headless" });
    expect(def).toContain("headless agent");
    expect(explicit).toContain("headless agent");
    expect(def).not.toContain("live agent");
    expect(explicit).not.toContain("live agent");
  });

  it("keeps skills, context and role blocks shared across operating modes", () => {
    const prompt = buildAgentRunPrompt({
      rolePrompt: "ROLE",
      operatingMode: "live",
      skills: ["tdd"],
      context: [{ type: "note", content: "SPEC" }],
    });
    const contract = prompt.indexOf("Operating mode");
    const skills = prompt.indexOf("Skills to apply");
    const context = prompt.indexOf("Shared context");
    const role = prompt.indexOf("ROLE");
    expect(contract).toBeLessThan(skills);
    expect(skills).toBeLessThan(context);
    expect(context).toBeLessThan(role);
  });

  it("coordinates via injected structured context, not docs/agent-team free-text files", () => {
    const prompt = buildAgentRunPrompt({ rolePrompt: "ROLE" });
    // The standalone-but-composable contract: no legacy handoff-file convention in the preamble.
    expect(prompt).not.toContain("docs/agent-team");
    expect(prompt).toContain("structured summary");
  });

  it("orders blocks: contract, skills, context, then the role prompt", () => {
    const prompt = buildAgentRunPrompt({
      rolePrompt: "ROLE",
      skills: ["tdd"],
      context: [{ type: "note", content: "SPEC" }],
    });
    const contract = prompt.indexOf("Operating mode");
    const skills = prompt.indexOf("Skills to apply");
    const context = prompt.indexOf("Shared context");
    const role = prompt.indexOf("ROLE");
    expect(contract).toBeLessThan(skills);
    expect(skills).toBeLessThan(context);
    expect(context).toBeLessThan(role);
  });

  it("teaches the parseable plan.md format only for a plan-emitting (Planner) run", () => {
    const planner = buildAgentRunPrompt({ rolePrompt: "ROLE", emitsPlan: true });
    expect(planner).toContain("docs/agent-team/plan.md");
    expect(planner).toContain("- [ ] task (owner: Name)");
    // A non-Planner agent never gets the plan.md format instruction.
    expect(buildAgentRunPrompt({ rolePrompt: "ROLE" })).not.toContain("docs/agent-team/plan.md");
  });

  it("injects the canvas roster as owner vocabulary only for a plan-emitting run", () => {
    const planner = buildAgentRunPrompt({
      rolePrompt: "ROLE",
      emitsPlan: true,
      roster: ["Coder", "QA Engineer"],
    });
    expect(planner).toContain("Teammates on the canvas");
    expect(planner).toContain("Coder, QA Engineer");
  });

  it("omits the roster block for non-plan runs even when teammates are present", () => {
    expect(buildAgentRunPrompt({ rolePrompt: "ROLE", roster: ["Coder"] })).not.toContain("Teammates on the canvas");
    expect(buildAgentRunPrompt({ rolePrompt: "ROLE", emitsPlan: true })).not.toContain("Teammates on the canvas");
  });

  it("injects a read-only notice only when permissions are not skipped", () => {
    expect(buildAgentRunPrompt({ rolePrompt: "R", skipPermissions: false })).toContain("READ-ONLY");
    expect(buildAgentRunPrompt({ rolePrompt: "R", skipPermissions: true })).not.toContain("READ-ONLY");
    expect(buildAgentRunPrompt({ rolePrompt: "R" })).not.toContain("READ-ONLY");
  });

  it("omits skills and context blocks when there is nothing to inject", () => {
    const prompt = buildAgentRunPrompt({ rolePrompt: "R", skills: [" ", ""], context: [{ type: "note", content: "  " }] });
    expect(prompt).not.toContain("Skills to apply");
    expect(prompt).not.toContain("Shared context");
  });

  it("includes only note sources as context, deduping and trimming skills", () => {
    const prompt = buildAgentRunPrompt({
      rolePrompt: "R",
      skills: [" tdd ", "tdd", "qa"],
      context: [
        { type: "note", content: " spec text " },
        { type: "agent", content: "ignored" },
      ],
    });
    expect(prompt).toContain("invoke each via the Skill tool): tdd, qa.");
    expect(prompt).toContain("spec text");
    expect(prompt).not.toContain("ignored");
  });

  it("renders an upstream agent's handoff artifact, labelled by its name", () => {
    const prompt = buildAgentRunPrompt({
      rolePrompt: "ROLE",
      context: [{ type: "handoff", name: "Architect", content: " designed the schema " }],
    });
    expect(prompt).toContain("# Handoff from Architect");
    expect(prompt).toContain("designed the schema");
    expect(prompt.indexOf("Handoff from Architect")).toBeLessThan(prompt.indexOf("ROLE"));
  });

  it("renders embedded Note Asset manifests with the note Markdown fallback", () => {
    const prompt = buildAgentRunPrompt({
      rolePrompt: "ROLE",
      context: [{ type: "note", content: "# Spec\n\n![diagram](lotus-note-asset://asset_1)", assets: [{ id: "asset_1", alt: "diagram" }] }],
    });
    expect(prompt).toContain("# Spec");
    expect(prompt).toContain("![diagram](lotus-note-asset://asset_1)");
    expect(prompt).toContain("Embedded images:");
    expect(prompt).toContain("- asset_1: diagram (lotus-note-asset://asset_1)");
  });

  it("keeps notes and handoffs as distinct blocks, in that order", () => {
    const prompt = buildAgentRunPrompt({
      rolePrompt: "ROLE",
      context: [
        { type: "handoff", name: "Backend", content: "built the API" },
        { type: "note", content: "the spec" },
      ],
    });
    expect(prompt.indexOf("Shared context")).toBeLessThan(prompt.indexOf("Handoff from Backend"));
    expect(prompt).toContain("the spec");
    expect(prompt).toContain("built the API");
  });

  it("falls back to a generic label and skips empty handoffs", () => {
    const named = buildAgentRunPrompt({ rolePrompt: "R", context: [{ type: "handoff", content: "x" }] });
    expect(named).toContain("# Handoff from upstream agent");
    const empty = buildAgentRunPrompt({ rolePrompt: "R", context: [{ type: "handoff", name: "A", content: "  " }] });
    expect(empty).not.toContain("Handoff from");
  });

  it("renders a context-bus artifact with its key and producer", () => {
    const prompt = buildAgentRunPrompt({
      rolePrompt: "ROLE",
      context: [{ type: "context", key: "Architect", name: "Architect", content: "the schema" }],
    });
    expect(prompt).toContain("# Context: Architect (from Architect)");
    expect(prompt).toContain("the schema");
    expect(prompt).not.toContain("earlier run");
  });

  it("marks a stale bus artifact (read from a different run) with a warning", () => {
    const prompt = buildAgentRunPrompt({
      rolePrompt: "ROLE",
      context: [{ type: "context", key: "k", name: "A", content: "data", stale: true }],
    });
    expect(prompt).toContain("# Context: k (from A)");
    expect(prompt).toContain("earlier run");
  });

  it("names a connected File Node's path and does not carry its contents", () => {
    const prompt = buildAgentRunPrompt({
      rolePrompt: "ROLE",
      context: [{ type: "file", path: "/repo/src/a.ts" }, { type: "file", path: "/repo/src/b.ts" }],
    });
    expect(prompt).toContain("# Files on the board");
    expect(prompt).toContain("/repo/src/a.ts");
    expect(prompt).toContain("/repo/src/b.ts");
  });
});
