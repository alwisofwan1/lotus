import { describe, expect, it, vi } from "vitest";
import { composeNarrationLine } from "../narration-compose";
import type { NarrationEvent } from "../narration-event";

const NOW = 1_700_000_000_000;

const ev = (over: Partial<NarrationEvent> = {}): NarrationEvent => ({
  kind: "final",
  tag: "final",
  neutral: "I refactored the auth flow across fourteen files and the suite is green.",
  paneId: "canvas:projA:node-9",
  ts: NOW,
  ...over,
});

const deps = (over: Partial<Parameters<typeof composeNarrationLine>[1]> = {}) => ({
  personaBody: "You are a poised, courteous AI valet.",
  complete: vi.fn(async () => "Refactored the auth flow — suite is green."),
  ...over,
});

describe("composeNarrationLine — the fast-path gate", () => {
  it("never calls the model for a routine tool event", () => {
    // Heard's finding: 70-80% of events must bypass the model or narration trails the work it is
    // describing. A tool event already has a good deterministic phrase.
    const d = deps();
    const line = composeNarrationLine(ev({ kind: "tool_pre", tag: "tool_edit", filePath: "/r/a/auth.ts" }), d);

    return line.then((text) => {
      expect(text).toBe("editing auth");
      expect(d.complete).not.toHaveBeenCalled();
    });
  });

  it("never calls the model for a failure", async () => {
    // The invariant from PLAN.md: failures take the deterministic path ALWAYS. A dead key must
    // never mean a regression goes by unspoken.
    const d = deps();
    const line = await composeNarrationLine(ev({ kind: "tool_post", tag: "tool_post_failure", neutral: "exit 1" }), d);

    expect(line).toBe("that command failed");
    expect(d.complete).not.toHaveBeenCalled();
  });
});

describe("composeNarrationLine — the summary path", () => {
  it("speaks the model's short line instead of the agent's whole reply", async () => {
    const d = deps();
    const line = await composeNarrationLine(ev(), d);

    expect(line).toBe("Refactored the auth flow — suite is green.");
  });

  it("prompts with the shared policy and the persona, in that order", async () => {
    let prompt = "";
    const complete = vi.fn(async (p: string) => {
      prompt = p;
      return "ok";
    });
    await composeNarrationLine(ev(), deps({ complete }));

    const policyAt = prompt.indexOf("Never speak code");
    const personaAt = prompt.indexOf("poised, courteous AI valet");
    expect(policyAt).toBeGreaterThanOrEqual(0);
    expect(personaAt).toBeGreaterThanOrEqual(0);
    expect(policyAt).toBeLessThan(personaAt);
  });

  it("falls back to the template when the model fails", async () => {
    const d = deps({ complete: vi.fn(async () => { throw new Error("no_key"); }) });
    const line = await composeNarrationLine(ev(), d);

    expect(line).toBe("I refactored the auth flow across fourteen files and the suite is green.");
  });

  it("falls back when the model runs away rather than speaking an essay", async () => {
    // The cap is a safety net on OUR side. Heard shipped a 160-token cap that chopped narration
    // mid-sentence and sent the fragment to TTS; brevity comes from the prompt, this catches the
    // times the model ignores it.
    const d = deps({ complete: vi.fn(async () => "word ".repeat(200)) });
    const line = await composeNarrationLine(ev(), d);

    expect(line).toBe("I refactored the auth flow across fourteen files and the suite is green.");
  });

  it("stays silent when a prompt paraphrase is unavailable", async () => {
    // Reading the user's own words back at them is worse than saying nothing.
    const d = deps({ complete: vi.fn(async () => { throw new Error("no_key"); }) });
    const line = await composeNarrationLine(ev({ kind: "prompt_intent", tag: "prompt_intent", neutral: "fix the auth bug" }), d);

    expect(line).toBeNull();
  });
});
