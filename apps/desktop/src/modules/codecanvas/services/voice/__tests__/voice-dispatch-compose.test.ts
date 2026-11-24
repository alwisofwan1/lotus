import { describe, it, expect, vi } from "vitest";
import {
  buildVoiceDispatchComposePrompt,
  composeVoiceDispatchPrompt,
  composeVoiceDispatchPromptDetailed,
  shouldComposeVoicePrompt,
  stripLeadingAddressingFrame,
} from "../voice-dispatch-compose";

describe("shouldComposeVoicePrompt", () => {
  it("skips the model for a short clean command so terse dispatches stay instant", () => {
    expect(shouldComposeVoicePrompt("run the tests")).toBe(false);
    expect(shouldComposeVoicePrompt("status?")).toBe(false);
  });

  it("composes once speech is long enough to carry disfluency and structure", () => {
    expect(
      shouldComposeVoicePrompt(
        "okay I'm down with putting this on my server that's fine is it possible for me to run this from the simulator",
      ),
    ).toBe(true);
  });

  it("composes a short utterance that still carries a filler or an addressing frame", () => {
    expect(shouldComposeVoicePrompt("um run the tests")).toBe(true);
    expect(shouldComposeVoicePrompt("Rowan, run the tests")).toBe(true);
    expect(shouldComposeVoicePrompt("bilang ke Sage jalankan tes")).toBe(true);
  });

  it("never composes empty or whitespace-only speech", () => {
    expect(shouldComposeVoicePrompt("")).toBe(false);
    expect(shouldComposeVoicePrompt("   ")).toBe(false);
  });
});

describe("stripLeadingAddressingFrame", () => {
  it("drops an English relay frame — the target is already resolved by the dispatch tool", () => {
    expect(stripLeadingAddressingFrame("Can you please prompt Marshall that okay I'm down with this")).toBe(
      "okay I'm down with this",
    );
    expect(stripLeadingAddressingFrame("tell Rowan to run the tests")).toBe("run the tests");
    expect(stripLeadingAddressingFrame("ask Sage what she found")).toBe("what she found");
  });

  it("drops an Indonesian relay frame", () => {
    expect(stripLeadingAddressingFrame("bilang ke Rowan bahwa jangan ubah kodenya")).toBe("jangan ubah kodenya");
    expect(stripLeadingAddressingFrame("tolong sampaikan ke Sage untuk cek log")).toBe("cek log");
  });

  it("drops a bare vocative address", () => {
    expect(stripLeadingAddressingFrame("Rowan, run the tests")).toBe("run the tests");
  });

  it("leaves speech that never addressed anyone untouched", () => {
    expect(stripLeadingAddressingFrame("run the tests and report back")).toBe("run the tests and report back");
  });

  it("never strips down to nothing — a frame-only utterance is returned as-is", () => {
    expect(stripLeadingAddressingFrame("tell Rowan")).toBe("tell Rowan");
  });

  it("never mistakes a pronoun for the addressee — that would reverse the meaning", () => {
    expect(stripLeadingAddressingFrame("ask me before you change anything")).toBe(
      "ask me before you change anything",
    );
    expect(stripLeadingAddressingFrame("tell me what you found")).toBe("tell me what you found");
  });

  it("never mistakes a sequencer for a vocative — ordering information must survive", () => {
    expect(stripLeadingAddressingFrame("First, run the tests then commit")).toBe("First, run the tests then commit");
    expect(stripLeadingAddressingFrame("Terus, cek log-nya")).toBe("Terus, cek log-nya");
  });

  it("requires roster confirmation for a bare vocative once a roster is known", () => {
    expect(stripLeadingAddressingFrame("Rowan, run the tests", ["Rowan", "Sage"])).toBe("run the tests");
    // Not a teammate — "Auth", here, is the subject of the sentence, not an addressee.
    expect(stripLeadingAddressingFrame("Auth, run the tests", ["Rowan", "Sage"])).toBe("Auth, run the tests");
  });

  it("still trusts an explicit relay verb even when the name is off-roster", () => {
    expect(stripLeadingAddressingFrame("tell Marshall that the build is green", ["Rowan"])).toBe(
      "the build is green",
    );
  });
});

describe("buildVoiceDispatchComposePrompt", () => {
  const transcript = "um can you please prompt Rowan that I'm down with putting this on my server";

  it("embeds the transcript and the CNVS-parity transformations", () => {
    const prompt = buildVoiceDispatchComposePrompt(transcript, { target: "Rowan" });
    const lower = prompt.toLowerCase();
    expect(prompt).toContain(transcript);
    expect(lower).toContain("filler");
    expect(lower).toMatch(/self-correct/);
    expect(lower).toContain("punctuation");
    // The relay frame must go: the agent is the reader, not a third party.
    expect(lower).toMatch(/addressing|third person|already been routed/);
  });

  it("locks fidelity: first person, same language, every detail, never summarise", () => {
    const lower = buildVoiceDispatchComposePrompt(transcript, { target: "Rowan" }).toLowerCase();
    expect(lower).toContain("first person");
    expect(lower).toMatch(/same language/);
    expect(lower).toMatch(/never summari[sz]e|do not summari[sz]e/);
    expect(lower).toMatch(/every detail|all detail/);
  });

  it("demands bare prose — no headers, no preamble, no quotes", () => {
    const lower = buildVoiceDispatchComposePrompt(transcript, { target: "Rowan" }).toLowerCase();
    expect(lower).toMatch(/no (markdown )?heading|no header/);
    expect(lower).toContain("output only");
  });

  it("names the reading agent so the rewrite can address it directly", () => {
    expect(buildVoiceDispatchComposePrompt(transcript, { target: "Rowan" })).toContain("Rowan");
  });

  it("omits the grounding permission entirely when there is no deictic to resolve", () => {
    const prompt = buildVoiceDispatchComposePrompt("jalankan tes lalu laporkan hasilnya", {
      target: "Rowan",
      workspace: { git: { branch: "main", changedCount: 3 } },
    });
    expect(prompt).not.toContain("main");
    expect(prompt.toLowerCase()).not.toContain("resolve");
  });

  it("permits deictic grounding — and only that — when speech leans on unstated context", () => {
    const prompt = buildVoiceDispatchComposePrompt("fix this and then push it", {
      target: "Rowan",
      workspace: { git: { branch: "feat/x", changedCount: 2, changedFiles: ["a.ts", "b.ts"] } },
    });
    expect(prompt).toContain("feat/x");
    expect(prompt).toContain("a.ts");
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/only to resolve|resolve .*(vague|deictic)/);
    expect(lower).toMatch(/never .*(add|new) (task|scope)|not a license/);
  });

  it("adds canvas vocabulary as a bounded mis-hearing allow-list", () => {
    const prompt = buildVoiceDispatchComposePrompt(transcript, { target: "Rowan", vocabulary: ["Sage", "Rowan"] });
    expect(prompt).toContain("Sage, Rowan");
    expect(prompt.toLowerCase()).toContain("never invent or insert");
  });

  it("teaches how dictated technical terms are written — the tokens STT mangles most", () => {
    const prompt = buildVoiceDispatchComposePrompt(transcript, { target: "Rowan" });
    // Spoken-out acronyms, dictated paths, dictated flags: each needs its own worked mapping.
    expect(prompt).toContain("UI");
    expect(prompt).toContain("src/modules/voice");
    expect(prompt).toContain("auth.ts");
    expect(prompt).toContain("--verbose");
    // …and a brake, so an uncertain "correction" cannot rewrite a term the speaker meant.
    expect(prompt.toLowerCase()).toMatch(/when in doubt, keep what was said/);
  });

  it("distinguishes an abandoned false start from a clarification the speaker meant to add", () => {
    const lower = buildVoiceDispatchComposePrompt(transcript, { target: "Rowan" }).toLowerCase();
    expect(lower).toMatch(/delete a false start .*abandoned/);
    expect(lower).toMatch(/em-dash/);
  });

  it("protects the speaker's register and hedges — tone carries information", () => {
    const lower = buildVoiceDispatchComposePrompt(transcript, { target: "Rowan" }).toLowerCase();
    expect(lower).toMatch(/blunt request stays blunt/);
    expect(lower).toMatch(/hedge/);
  });

  it("carries one worked before/after example — the contract is too strict to state in rules alone", () => {
    const prompt = buildVoiceDispatchComposePrompt(transcript, { target: "Rowan" });
    expect(prompt).toContain("Example.");
    // The example must demonstrate the transformation, not just assert it: spoken "terminal user
    // interface" in, written "terminal UI" out.
    expect(prompt).toContain("the terminal user interface");
    expect(prompt).toContain("the terminal UI");
  });
});

describe("composeVoiceDispatchPrompt", () => {
  const long = "um can you please prompt Rowan that I'm down with putting this on my server that's fine";

  it("returns the composed prose, trimmed and unwrapped of stray quotes/fences", async () => {
    const callModel = vi.fn().mockResolvedValue('  "I\'m down with putting this on my server."  ');
    expect(await composeVoiceDispatchPrompt(long, callModel, { target: "Rowan" })).toBe(
      "I'm down with putting this on my server.",
    );
  });

  it("fails OPEN to a locally de-framed transcript when the model errors", async () => {
    const callModel = vi.fn().mockRejectedValue(new Error("model down"));
    expect(await composeVoiceDispatchPrompt("tell Rowan to run the tests and report back", callModel, { target: "Rowan" })).toBe(
      "run the tests and report back",
    );
  });

  // Fail-open is always the LOCALLY de-framed transcript: de-framing is deterministic and does not
  // depend on the model, so a model failure must not resurrect the relay frame.
  it("fails open when the model returns empty", async () => {
    const callModel = vi.fn().mockResolvedValue("   ");
    expect(await composeVoiceDispatchPrompt(long, callModel, { target: "Rowan" })).toBe(
      "I'm down with putting this on my server that's fine",
    );
  });

  it("skips the model entirely for a short clean command", async () => {
    const callModel = vi.fn();
    expect(await composeVoiceDispatchPrompt("run the tests", callModel, { target: "Rowan" })).toBe("run the tests");
    expect(callModel).not.toHaveBeenCalled();
  });

  it("rejects a composition that collapsed the request — fidelity outranks polish", async () => {
    const spoken =
      "okay I'm down with putting this on my server that's fine is it possible for me to run this from the simulator " +
      "that runs on my Mac here and test it end to end from the iPhone simulator also remember I'm live streaming today " +
      "so no secrets in the terminal and just give me an ultra brief reply back";
    const callModel = vi.fn().mockResolvedValue("Deploy to the server.");
    expect(await composeVoiceDispatchPrompt(spoken, callModel, { target: "Rowan" })).toBe(spoken);
  });

  it("keeps a faithful composition of similar length", async () => {
    const spoken = "um so I want you to run the whole test suite and then tell me which files are failing please";
    const composed = "Run the whole test suite, then tell me which files are failing.";
    const callModel = vi.fn().mockResolvedValue(composed);
    expect(await composeVoiceDispatchPrompt(spoken, callModel, { target: "Rowan" })).toBe(composed);
  });

  it("never returns an empty string for non-empty speech", async () => {
    const callModel = vi.fn().mockResolvedValue("");
    const out = await composeVoiceDispatchPrompt(long, callModel, { target: "Rowan" });
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it("rejects a rewrite that lost a concrete detail, however fluent it reads", async () => {
    const spoken = "um so can you restart the dev server on port 3000 and then tail the log for me please";
    const callModel = vi.fn().mockResolvedValue("Restart the dev server, then tail the log for me.");
    expect(await composeVoiceDispatchPrompt(spoken, callModel, { target: "Rowan" })).toBe(spoken);
  });

  it("rejects a rewrite that dropped the user's prohibition — that is a reversal, not a polish", async () => {
    const spoken = "hey just review the auth module for me but don't change any of the code in there okay";
    const callModel = vi.fn().mockResolvedValue("Review the auth module and fix the code in there.");
    // Fail-open is the de-framed transcript; there is no relay frame here, so it is the speech itself.
    expect(await composeVoiceDispatchPrompt(spoken, callModel, { target: "Rowan" })).toBe(spoken);
  });

  it("delivers the user's own words when the model stalls past the deadline", async () => {
    const callModel = vi.fn().mockImplementation(() => new Promise<string>(() => {}));
    const result = await composeVoiceDispatchPromptDetailed(
      "tell Rowan to run the tests and then report what is failing",
      callModel,
      { target: "Rowan", timeoutMs: 10 },
    );
    expect(result).toMatchObject({
      outcome: "timeout",
      text: "run the tests and then report what is failing",
    });
  });
});

describe("composeVoiceDispatchPromptDetailed", () => {
  it("reports why the delivered text is what it is, so a silent fallback is diagnosable", async () => {
    const long = "um can you please prompt Rowan that I'm down with putting this on my server that's fine";

    await expect(
      composeVoiceDispatchPromptDetailed("run the tests", vi.fn(), { target: "Rowan" }),
    ).resolves.toMatchObject({ outcome: "skipped" });

    await expect(
      composeVoiceDispatchPromptDetailed(long, vi.fn().mockResolvedValue("I'm fine putting this on my server."), {
        target: "Rowan",
      }),
    ).resolves.toMatchObject({ outcome: "composed" });

    await expect(
      composeVoiceDispatchPromptDetailed(long, vi.fn().mockRejectedValue(new Error("down")), { target: "Rowan" }),
    ).resolves.toMatchObject({ outcome: "error" });

    await expect(
      composeVoiceDispatchPromptDetailed(long, vi.fn().mockResolvedValue("  "), { target: "Rowan" }),
    ).resolves.toMatchObject({ outcome: "empty" });

    await expect(
      composeVoiceDispatchPromptDetailed("um restart the dev server on port 3000 and tail the log for me", vi.fn().mockResolvedValue("Restart the dev server and tail the log."), {
        target: "Rowan",
      }),
    ).resolves.toMatchObject({ outcome: "rejected", failure: "detail-loss" });
  });
});
