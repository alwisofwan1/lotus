import { describe, expect, it, vi } from "vitest";
import { composeBurstLine, joinBurstLines } from "../burst-intent";

const deps = (over: Partial<Parameters<typeof composeBurstLine>[1]> = {}) => ({
  personaBody: "You are a poised, courteous AI valet.",
  complete: vi.fn(async () => "Getting the lay of the auth flow."),
  ...over,
});

describe("joinBurstLines — the deterministic floor", () => {
  it("joins a burst into one line", () => {
    expect(joinBurstLines(["editing auth", "editing token"])).toBe("editing auth, editing token");
  });

  it("returns a single line untouched", () => {
    expect(joinBurstLines(["editing auth"])).toBe("editing auth");
  });

  it("is null for nothing", () => {
    expect(joinBurstLines([])).toBeNull();
  });
});

describe("composeBurstLine", () => {
  it("says what the burst WAS, not what each step did", async () => {
    // "editing auth, editing token, editing session" is a list of mechanics. What the listener
    // wants is the arc: the agent is working out how auth is wired.
    const line = await composeBurstLine(["editing auth", "editing token", "editing session"], deps());

    expect(line).toBe("Getting the lay of the auth flow.");
  });

  it("does not pay a model round-trip for a single step", async () => {
    // One step is already an intent-level phrase; rewriting it would add latency and risk for
    // nothing.
    const d = deps();
    const line = await composeBurstLine(["editing auth"], d);

    expect(line).toBe("editing auth");
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("falls back to the joined list when the model fails", async () => {
    const d = deps({ complete: vi.fn(async () => { throw new Error("no_key"); }) });

    expect(await composeBurstLine(["editing auth", "ran a command"], d)).toBe("editing auth, ran a command");
  });

  it("falls back rather than speaking an essay", async () => {
    const d = deps({ complete: vi.fn(async () => "word ".repeat(200)) });

    expect(await composeBurstLine(["editing auth", "ran a command"], d)).toBe("editing auth, ran a command");
  });

  it("keeps the narration policy and the persona in the prompt, policy first", async () => {
    let prompt = "";
    const complete = vi.fn(async (p: string) => {
      prompt = p;
      return "ok";
    });
    await composeBurstLine(["a step", "another step"], deps({ complete }));

    const policyAt = prompt.indexOf("Never speak code");
    const personaAt = prompt.indexOf("poised, courteous AI valet");
    expect(policyAt).toBeGreaterThanOrEqual(0);
    expect(personaAt).toBeGreaterThanOrEqual(0);
    expect(policyAt).toBeLessThan(personaAt);
  });

  it("gives the model the steps it is summarising", async () => {
    let prompt = "";
    const complete = vi.fn(async (p: string) => {
      prompt = p;
      return "ok";
    });
    await composeBurstLine(["editing auth", "ran the tests"], deps({ complete }));

    expect(prompt).toContain("editing auth");
    expect(prompt).toContain("ran the tests");
  });
});
