import { describe, it, expect, vi } from "vitest";
import { buildDictationPolishPrompt, polishDictation } from "../dictation-polish";

describe("buildDictationPolishPrompt", () => {
  it("embeds the transcript, the reformatting fixes, and the meaning-preserving guardrails", () => {
    const prompt = buildDictationPolishPrompt("um so like fix the auth bug");
    const lower = prompt.toLowerCase();
    expect(prompt).toContain("um so like fix the auth bug");
    // Reformatting capabilities.
    expect(lower).toContain("filler");
    expect(lower).toContain("grammar");
    expect(lower).toContain("paragraph");
    // Meaning + safety contract — clean up, never rewrite/answer/execute.
    expect(lower).toMatch(/tone.*meaning|meaning.*intent/);
    expect(lower).toMatch(/never add or remove|never answer|never execute/);
    expect(lower).toContain("only");
  });

  it("clean mode + no vocabulary is unchanged from the bare prompt (backward compatible)", () => {
    expect(buildDictationPolishPrompt("fix the bug")).toBe(buildDictationPolishPrompt("fix the bug", { mode: "clean" }));
  });

  it("commit mode injects a conventional-commit instruction", () => {
    expect(buildDictationPolishPrompt("add oauth", { mode: "commit" }).toLowerCase()).toContain("conventional commit");
  });

  it("vocabulary adds a bounded name-correction allow-list (never an instruction to insert names)", () => {
    const prompt = buildDictationPolishPrompt("tell wren to fix it", { vocabulary: ["Ren", "Sora"] });
    expect(prompt).toContain("Ren, Sora");
    expect(prompt.toLowerCase()).toMatch(/correct obvious mis-hearings/);
    expect(prompt.toLowerCase()).toContain("never invent or insert");
  });

  it("omits the vocabulary line when the canvas has no names", () => {
    expect(buildDictationPolishPrompt("hello", { vocabulary: [] }).toLowerCase()).not.toContain("known names");
  });
});

describe("polishDictation", () => {
  it("applies deterministic corrections before and after AI without letting the model bypass fidelity", async () => {
    const raw = "please ask clod code to carefully inspect agents dot md and explain the repository architecture before proposing any implementation changes";
    const callModel = vi.fn().mockResolvedValue(
      "Please ask Claude Code to carefully inspect agents dot md and explain the repository architecture before proposing any implementation changes.",
    );
    const result = await polishDictation(raw, callModel, {
      replacements: [
        { id: "claude", variants: ["clod code"], replacement: "Claude Code", timing: "before-ai", enabled: true },
        { id: "agents", variants: ["agents dot md"], replacement: "AGENTS.md", timing: "after-ai", enabled: true },
      ],
    });

    expect(callModel).toHaveBeenCalledWith(expect.stringContaining("ask Claude Code to carefully inspect agents dot md"), expect.any(AbortSignal));
    expect(result).toBe(
      "Please ask Claude Code to carefully inspect AGENTS.md and explain the repository architecture before proposing any implementation changes.",
    );
  });

  it("keeps short prompts deterministic because semantic fidelity cannot be proven", async () => {
    const callModel = vi.fn().mockResolvedValue("Audit the architecture and produce a migration plan.");
    const raw = "Tolong analisis dan jelaskan proyek ini secara singkat";

    expect(await polishDictation(raw, callModel)).toBe(raw);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("returns the model's cleaned text, trimmed and unwrapped of stray quotes for substantial dictation", async () => {
    const callModel = vi.fn().mockResolvedValue('  "Please fix the authentication bug in the login flow before running the focused regression tests."  ');
    expect(
      await polishDictation("um please fix the authentication bug in the login flow before you run the focused regression tests", callModel),
    ).toBe("Please fix the authentication bug in the login flow before running the focused regression tests.");
  });

  it("stops waiting for cleanup immediately when the owning turn is aborted", async () => {
    const raw = "Please review the authentication implementation carefully and verify every regression before changing the production login flow today.";
    const aborter = new AbortController();
    const pending = polishDictation(raw, () => new Promise<string>(() => {}), { signal: aborter.signal });

    aborter.abort();
    const outcome = await Promise.race([
      pending,
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 20)),
    ]);

    expect(outcome).toBe(raw);
  });

  it("fails OPEN to the raw transcript when cleanup exceeds its default latency budget", async () => {
    vi.useFakeTimers();
    try {
      const raw = "Please review the authentication implementation carefully and verify every regression before changing the production login flow today.";
      const neverSettles = new Promise<string>(() => {});
      const pending = polishDictation(raw, () => neverSettles);

      await vi.advanceTimersByTimeAsync(900);
      const outcome = await Promise.race([pending, Promise.resolve("still-pending")]);

      expect(outcome).toBe(raw);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails OPEN to the raw transcript when the model errors", async () => {
    const callModel = vi.fn().mockRejectedValue(new Error("model down"));
    expect(await polishDictation("fix the auth bug", callModel)).toBe("fix the auth bug");
  });

  it("rejects cleanup that drops a path, version, number, or other critical detail", async () => {
    const raw = "Please update src/auth.ts for version 19.2.1 on port 3000.";
    const callModel = vi.fn().mockResolvedValue("Please update the authentication code.");

    expect(await polishDictation(raw, callModel)).toBe(raw);
  });

  it("rejects cleanup that removes a prohibition", async () => {
    const raw = "Review the auth flow but don't change any code.";
    const callModel = vi.fn().mockResolvedValue("Review and improve the auth flow.");

    expect(await polishDictation(raw, callModel)).toBe(raw);
  });

  it("rejects cleanup that expands into an invented plan", async () => {
    const raw = "Please review the login flow and tell me why it feels fragile.";
    const callModel = vi.fn().mockResolvedValue(
      "Review the login flow, fix every fragile area, add end-to-end tests, document the architecture, " +
        "raise coverage above ninety percent, open follow-up tickets, and deploy the completed changes.",
    );

    expect(await polishDictation(raw, callModel)).toBe(raw);
  });

  it("fails open to the raw transcript when the model returns empty", async () => {
    const callModel = vi.fn().mockResolvedValue("   ");
    expect(await polishDictation("fix the auth bug", callModel)).toBe("fix the auth bug");
  });

  it("does not call the model for an empty transcript", async () => {
    const callModel = vi.fn();
    expect(await polishDictation("   ", callModel)).toBe("");
    expect(callModel).not.toHaveBeenCalled();
  });
});


describe("polish request cancellation", () => {
  const raw = "Please review the authentication implementation carefully and verify every regression before changing the production login flow today.";
  it.each(["timeout", "cancel"])("aborts the underlying model on %s", async (cause) => {
    vi.useFakeTimers();
    try {
      const owner = new AbortController();
      let requestSignal: AbortSignal | undefined;
      const pending = polishDictation(raw, (_prompt, signal) => {
        requestSignal = signal;
        return new Promise<string>(() => {});
      }, { signal: owner.signal });
      if (cause === "cancel") owner.abort();
      else await vi.advanceTimersByTimeAsync(900);
      expect(await pending).toBe(raw);
      expect(requestSignal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("does not start a model for an already cancelled turn", async () => {
    const owner = new AbortController(); owner.abort();
    const model = vi.fn();
    expect(await polishDictation(raw, model, { signal: owner.signal })).toBe(raw);
    expect(model).not.toHaveBeenCalled();
  });
});
