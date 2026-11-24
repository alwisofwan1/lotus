import { describe, expect, it, vi } from "vitest";
import { buildRefinePrompt, hasVagueReference, looksVerbatim, refineDispatchBatch } from "../refine-dispatch-prompt";
import type { NlResolution } from "../canvas-nl-command";

function dispatchRes(text: string, agentId = "a1"): NlResolution {
  return { effect: { kind: "dispatch", agentId, text }, destructive: false, summary: "Dispatch", speak: "" };
}

const commandRes = {
  effect: { kind: "command", command: { kind: "arrange" } },
  destructive: false,
  summary: "Arrange",
  speak: "",
} as unknown as NlResolution;

// Eligible for refinement: ≥ threshold words AND a deictic ("this"/"it") that grounding can resolve.
const LONG = "please refactor this authentication module and add unit tests covering it";
// Explicit + self-contained (no vague reference) → W1a skips refinement and dispatches verbatim.
const EXPLICIT = "please refactor the authentication module and add unit tests";
const baseCtx = { rawQuery: "do the thing", projectName: "demo", agentProfile: () => ({ name: "Skye" }) };

describe("looksVerbatim", () => {
  it("detects verbatim escape phrases", () => {
    expect(looksVerbatim("send this verbatim to Skye")).toBe(true);
    expect(looksVerbatim("tell her word-for-word")).toBe(true);
    expect(looksVerbatim("pass it as-is")).toBe(true);
  });
  it("is false for ordinary requests", () => {
    expect(looksVerbatim("tell Skye to fix the login bug")).toBe(false);
  });
});

describe("refineDispatchBatch", () => {
  it("rewrites a substantial dispatch message via the model", async () => {
    const callModel = vi.fn(async () => "Refactor the auth module; add unit tests covering the new paths.");
    const out = await refineDispatchBatch([dispatchRes(LONG)], { ...baseCtx, callModel });

    expect(callModel).toHaveBeenCalledOnce();
    expect(out[0].effect).toMatchObject({ kind: "dispatch", text: "Refactor the auth module; add unit tests covering the new paths." });
  });

  // Typed text is already written prose. A stated constraint used to trigger the relay envelope; it no
  // longer does, because the typed sentence itself is the authority and nothing needs labelling.
  it("passes a constraint-bearing typed dispatch through untouched, with no model round-trip", async () => {
    const task = "Audit src/auth.ts and package.json, report 5 P0–P2 findings with file:line evidence; analysis only, do not edit files.";
    const callModel = vi.fn(async () => "should not be used");
    const out = await refineDispatchBatch([dispatchRes(task)], { ...baseCtx, rawQuery: task, callModel });

    expect(callModel).not.toHaveBeenCalled();
    expect(out[0].effect).toMatchObject({ kind: "dispatch", text: task });
    expect((out[0].effect as { text: string }).text).not.toContain("# Delegated voice task");
  });

  it("flags a typed dispatch whose tail looks cut off, without wrapping it in scaffolding", async () => {
    const task = "Audit src/auth.ts and package.json, do not edit files and then";
    const callModel = vi.fn(async () => "should not be used");
    const out = await refineDispatchBatch([dispatchRes(task)], { ...baseCtx, rawQuery: task, callModel });

    expect(callModel).not.toHaveBeenCalled();
    const text = (out[0].effect as { text: string }).text;
    expect(text).toContain(task);
    expect(text).toContain("may have been cut off at the end");
    expect(text).not.toMatch(/^#{1,6}\s/m);
  });

  it("leaves short dispatches untouched (no model call)", async () => {
    const callModel = vi.fn(async () => "should not be used");
    const out = await refineDispatchBatch([dispatchRes("fix the bug")], { ...baseCtx, callModel });

    expect(callModel).not.toHaveBeenCalled();
    expect(out[0].effect).toMatchObject({ text: "fix the bug" });
  });

  it("skips refinement for an explicit dispatch with no vague reference — verbatim, no model call (W1a)", async () => {
    const callModel = vi.fn(async () => "should not be used");
    const out = await refineDispatchBatch([dispatchRes(EXPLICIT)], { ...baseCtx, callModel });

    expect(callModel).not.toHaveBeenCalled();
    expect(out[0].effect).toMatchObject({ text: EXPLICIT });
  });

  it("never touches non-dispatch effects", async () => {
    const callModel = vi.fn(async () => "nope");
    const out = await refineDispatchBatch([commandRes], { ...baseCtx, callModel });

    expect(callModel).not.toHaveBeenCalled();
    expect(out[0]).toBe(commandRes);
  });

  it("honors the verbatim escape — whole batch passes through", async () => {
    const callModel = vi.fn(async () => "nope");
    const out = await refineDispatchBatch([dispatchRes(LONG)], { ...baseCtx, rawQuery: "send this verbatim", callModel });

    expect(callModel).not.toHaveBeenCalled();
    expect(out[0].effect).toMatchObject({ text: LONG });
  });

  it("fails open when refinement replaces the user's task with invented scope", async () => {
    const callModel = vi.fn(async () => "Audit the entire architecture, create a migration plan, and rewrite every service.");
    const out = await refineDispatchBatch([dispatchRes(LONG)], { ...baseCtx, callModel });

    expect(callModel).toHaveBeenCalledOnce();
    expect(out[0].effect).toMatchObject({ text: LONG });
  });

  it("fails open to the original text when the model errors", async () => {
    const callModel = vi.fn(async () => { throw new Error("timeout"); });
    const out = await refineDispatchBatch([dispatchRes(LONG)], { ...baseCtx, callModel });

    expect(out[0].effect).toMatchObject({ text: LONG });
  });

  it("gathers workspace context once and injects it into the rewrite prompt (Fase 2)", async () => {
    const prompts: string[] = [];
    const callModel = vi.fn(async (p: string) => { prompts.push(p); return "Refined."; });
    const getWorkspace = vi.fn(async () => ({
      git: { branch: "main", ahead: 2, changedCount: 3, changedFiles: ["a.ts", "b.ts"] },
      selection: ["agent Skye"],
    }));

    await refineDispatchBatch([dispatchRes(LONG)], { ...baseCtx, callModel, getWorkspace });

    expect(getWorkspace).toHaveBeenCalledOnce();
    expect(prompts[0]).toContain("on branch main");
    expect(prompts[0]).toContain("Selected on the canvas: agent Skye");
  });

  it("never gathers workspace context for short / verbatim / non-dispatch batches", async () => {
    const callModel = vi.fn(async () => "x");
    const getWorkspace = vi.fn(async () => ({}));

    await refineDispatchBatch([dispatchRes("fix the bug")], { ...baseCtx, callModel, getWorkspace });
    await refineDispatchBatch([dispatchRes(LONG)], { ...baseCtx, rawQuery: "do it verbatim", callModel, getWorkspace });
    await refineDispatchBatch([commandRes], { ...baseCtx, callModel, getWorkspace });

    expect(getWorkspace).not.toHaveBeenCalled();
  });

  it("strips wrapping code fences and quotes from a faithful model output", async () => {
    const faithful = "Refactor this authentication module and add unit tests covering it.";
    const fenced = await refineDispatchBatch([dispatchRes(LONG)], {
      ...baseCtx,
      callModel: async () => `\`\`\`\n${faithful}\n\`\`\``,
    });
    expect(fenced[0].effect).toMatchObject({ text: faithful });

    const quoted = await refineDispatchBatch([dispatchRes(LONG)], {
      ...baseCtx,
      callModel: async () => `"${faithful}"`,
    });
    expect(quoted[0].effect).toMatchObject({ text: faithful });
  });
});

describe("hasVagueReference", () => {
  it("is true for deictic / under-specified references that grounding can resolve", () => {
    for (const t of ["fix this", "make it faster", "test everything", "review these changes", "handle the rest"]) {
      expect(hasVagueReference(t)).toBe(true);
    }
  });
  it("is false for self-contained explicit instructions (so they dispatch verbatim, instantly)", () => {
    for (const t of [
      "refactor the auth module and add tests",
      "add a login form with email and password validation",
      "run the migration and verify the schema",
    ]) {
      expect(hasVagueReference(t)).toBe(false);
    }
  });
});

describe("buildRefinePrompt context", () => {
  it("renders git + selection context and the grounding rule", () => {
    const prompt = buildRefinePrompt("commit everything", {
      projectName: "demo",
      workspace: {
        git: { branch: "main", ahead: 2, changedCount: 3, changedFiles: ["a.ts", "b.ts"] },
        selection: ["agent Skye"],
      },
    });
    expect(prompt).toContain("Repo state: on branch main, 2 ahead, 3 uncommitted files (a.ts, b.ts");
    expect(prompt).toContain("Selected on the canvas: agent Skye");
    expect(prompt).toContain("Use the context below ONLY");
  });

  it("omits the context block and grounding rule when there is none", () => {
    const prompt = buildRefinePrompt("commit everything", {});
    expect(prompt).not.toContain("Workspace context:");
    expect(prompt).not.toContain("Use the context below");
  });

  it("frames the prompt for the target agent's profile (Fase 3)", () => {
    const prompt = buildRefinePrompt("look at the auth changes", {
      agent: { name: "Rowan", role: "reviewer", runner: "codex", model: "gpt-5.5", skills: ["security-review"] },
    });
    expect(prompt).toContain("The instruction goes to Rowan, a codex agent (model gpt-5.5).");
    expect(prompt).toContain("Its role on the team: reviewer.");
    expect(prompt).toContain("Its applied skills: security-review.");
    expect(prompt).toContain("frame it for how the target agent works");
  });
});
