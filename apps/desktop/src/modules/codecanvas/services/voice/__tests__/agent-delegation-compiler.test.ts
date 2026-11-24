import { describe, expect, it } from "vitest";
import { evaluateDelegationFidelity } from "../delegation-fidelity";
import { compileAgentDelegation, hasSuspectTranscriptTail } from "../agent-delegation-compiler";
import { DELEGATION_FIDELITY_FIXTURES } from "./fixtures/delegation-fidelity-fixtures";

const mixedAudit = DELEGATION_FIDELITY_FIXTURES[0];

/** The real accumulator-duplication defect from plans/voice-dispatch-payload-integrity/PLAN.md §2.1. */
const CORRUPTED_ACCUMULATOR_SAMPLE =
  "Oke, thank you. Oke, thank you. Sekarang Oke, thank you. Sekarang suruh Nova untuk Oke, thank you. " +
  "Sekarang suruh Nova untuk jelaskan project. Oke, thank you. Sekarang suruh Nova untuk jelaskan project ini singkat saja. " +
  "Oke, thank you. Sekarang suruh Nova untuk jelaskan project ini singkat saja.";

describe("compileAgentDelegation", () => {
  it("preserves every explicit mixed-language requirement without wrapping it in an envelope", () => {
    const compilation = compileAgentDelegation({
      target: "Codex",
      transcript: mixedAudit.transcript,
      language: mixedAudit.language,
    });

    expect(compilation.packet).toMatchObject({
      target: "Codex",
      objective: mixedAudit.transcript,
      sourceTranscript: mixedAudit.transcript,
      language: "mixed",
    });
    expect(compilation.packet.doneWhen).toEqual([
      "Address every explicit requested output and constraint in the authoritative source transcript with evidence.",
    ]);

    const fidelity = evaluateDelegationFidelity({
      transcript: mixedAudit.transcript,
      deliveredText: compilation.workerMessage,
      requiredFacts: mixedAudit.requiredFacts,
    });
    expect(fidelity.score).toBe(1);
    expect(fidelity.missing).toEqual([]);

    // Clean and complete speech is the user's own words, not a relay packet (CNVS parity).
    expect(compilation.mode).toBe("direct");
    expect(compilation.workerMessage).toBe(mixedAudit.transcript);
    expect(compilation.workerMessage).not.toContain("# Delegated voice task");
    expect(compilation.workerMessage.toLowerCase()).not.toContain("implement the change");
    expect(compilation.workerMessage.toLowerCase()).not.toContain("add tests");
    expect(compilation.workerMessage.toLowerCase()).not.toContain("refactor the code");
  });

  it("keeps a short clear task verbatim instead of padding it with a structured envelope", () => {
    const transcript = "Perbaiki typo di README.md.";
    const compilation = compileAgentDelegation({
      target: "Nova",
      transcript,
      language: "id",
    });

    expect(compilation.mode).toBe("direct");
    expect(compilation.workerMessage).toBe(transcript);
  });

  // Constraint wording used to force an envelope. It no longer does: the user's own sentence already
  // states the boundary, and restating it as a bullet under a paraphrase is the duplication that made
  // the agent guess which rendition was authoritative.
  it("no longer envelopes a clean task just because it states an explicit no-change constraint", () => {
    const transcript = "Review auth.ts, do not modify files.";
    const compilation = compileAgentDelegation({
      target: "Codex",
      transcript,
      language: "en",
    });

    expect(compilation.mode).toBe("direct");
    expect(compilation.workerMessage).toBe(transcript);
  });

  it("keeps the model's intent as packet metadata only — a clean transcript still dispatches as prose", () => {
    const transcript = "Bisa tolong cek file auth.ts, terus lihat juga package.json untuk dependency yang outdated?";
    const compilation = compileAgentDelegation({
      target: "Nova",
      transcript,
      language: "auto",
      intent: "Review auth.ts and package.json for outdated dependencies.",
    });

    expect(compilation.mode).toBe("direct");
    expect(compilation.packet.objective).toBe("Review auth.ts and package.json for outdated dependencies.");
    // The intent must NOT reach the agent alongside the transcript — that is the two-renditions defect.
    expect(compilation.workerMessage).toBe(transcript);
    expect(compilation.workerMessage).not.toContain("Objective:");
  });

  it("folds keyConstraints into the prose request when there is no verbatim capture to carry them", () => {
    const compilation = compileAgentDelegation({
      target: "Codex",
      transcript: "",
      language: "en",
      intent: "Audit the auth module.",
      keyConstraints: ["analysis only, don't change code", "report file:line evidence"],
      transcriptPending: true,
    });

    expect(compilation.mode).toBe("structured");
    expect(compilation.workerMessage).toContain(
      "Audit the auth module. analysis only, don't change code. report file:line evidence.",
    );
    // Markdown scaffolding of any kind is what this whole rendering exists to avoid.
    expect(compilation.workerMessage).not.toContain("- analysis only");
    expect(compilation.workerMessage).not.toContain("#");
  });

  it("drops keyConstraints from a prose dispatch — the spoken sentence already carries them", () => {
    const transcript = "Audit the auth module and report findings, analysis only.";
    const compilation = compileAgentDelegation({
      target: "Codex",
      transcript,
      language: "en",
      intent: "Audit the auth module.",
      keyConstraints: ["analysis only, don't change code"],
    });

    expect(compilation.mode).toBe("direct");
    expect(compilation.workerMessage).toBe(transcript);
    expect(compilation.packet.keyConstraints).toEqual(["analysis only, don't change code"]);
  });

  it("keeps the caller's grounded objective out of the delivered text — the verbatim words win", () => {
    const transcript = "Cek dulu file auth.ts, terus tolong lihat juga apakah ada dependency yang outdated.";
    const compilation = compileAgentDelegation({
      target: "Nova",
      transcript,
      language: "id",
      groundedTask: "Review auth.ts and check for outdated dependencies in package.json.",
    });

    // A grounded objective is a SECOND rendition of a request the transcript already states. Shipping
    // both is the defect; the mode still switches so the caller skips its own rewrite on top.
    expect(compilation.mode).toBe("structured");
    expect(compilation.workerMessage).toBe(transcript);
    expect(compilation.packet.objective).toBe("Review auth.ts and check for outdated dependencies in package.json.");
  });

  it("delivers the paraphrase as plain prose with a trailing caveat when the transcript never arrived", () => {
    const compilation = compileAgentDelegation({
      target: "Skye",
      transcript: "",
      language: "auto",
      intent: "Restart the failing agent.",
      transcriptPending: true,
    });

    expect(compilation.mode).toBe("structured");
    expect(compilation.workerMessage).toBe(
      "Restart the failing agent.\n\n(Dictated by voice: this is a summary of what I said, not my exact words — ask me if anything is ambiguous.)",
    );
  });

  it("delivers the user's words plus a cut-off caveat when the transcript tail looks suspect", () => {
    const transcript = "Refactor the login flow and then";
    const compilation = compileAgentDelegation({
      target: "Codex",
      transcript,
      language: "en",
    });

    expect(compilation.mode).toBe("structured");
    // The words survive in full — only a short aside is added, the way a person would add it.
    expect(compilation.workerMessage).toBe(
      `${transcript}\n\n(Heads up: my message may have been cut off at the end — check with me before you act on the last part.)`,
    );
  });

  it("marks a clean transcript as transcriptQuality: clean and sends it as bare prose", () => {
    const transcript = "Review auth.ts, do not modify files.";
    const compilation = compileAgentDelegation({
      target: "Codex",
      transcript,
      language: "en",
    });

    expect(compilation.packet.transcriptQuality).toBe("clean");
    expect(compilation.packet.objectiveTrusted).toBe(true);
    expect(compilation.packet.transcriptIntegrity.quality).toBe("clean");
    expect(compilation.packet.transcriptIntegrity.reasons).toEqual([]);
    expect(compilation.workerMessage).toBe(transcript);
  });

  it("degrades the real observed accumulator-duplication defect to an intent-only packet with no verbatim block", () => {
    const compilation = compileAgentDelegation({
      target: "Nova",
      transcript: CORRUPTED_ACCUMULATOR_SAMPLE,
      language: "id",
      intent: "Jelaskan project ini secara singkat",
    });

    expect(compilation.packet.transcriptQuality).toBe("degraded");
    expect(compilation.packet.objectiveTrusted).toBe(true);
    expect(compilation.mode).toBe("structured");
    expect(compilation.workerMessage).not.toContain("Oke, thank you");
    expect(compilation.workerMessage).toContain("Jelaskan project ini secara singkat.");
    expect(compilation.workerMessage.toLowerCase()).toContain("came through garbled");
    expect(compilation.workerMessage.toLowerCase()).toContain("summary of what i said");
  });

  it("marks the packet unusable and keeps the corrupted transcript out of the worker message entirely when no independent objective was supplied", () => {
    const compilation = compileAgentDelegation({
      target: "Nova",
      transcript: CORRUPTED_ACCUMULATOR_SAMPLE,
      language: "auto",
    });

    expect(compilation.packet.transcriptQuality).toBe("degraded");
    expect(compilation.packet.objectiveTrusted).toBe(false);
    expect(compilation.mode).toBe("unusable");
    expect(compilation.packet.transcriptIntegrity.quality).toBe("degraded");
    expect(compilation.packet.transcriptIntegrity.reasons).toContain("repetition");

    // The whole point of this test: none of the corrupted text may leak into the worker message,
    // whether via a verbatim block or via a fallback Objective line.
    expect(compilation.workerMessage).not.toContain("Oke, thank you");
    expect(compilation.workerMessage).not.toContain("Sekarang suruh Nova");
    expect(compilation.workerMessage).not.toContain(CORRUPTED_ACCUMULATOR_SAMPLE);

    // The note must not falsely claim a paraphrase exists — there is no independent objective here.
    expect(compilation.workerMessage.toLowerCase()).not.toContain("summary of what i said");
    expect(compilation.workerMessage.toLowerCase()).toContain("could not recover what i asked for");
  });

  // The defect this whole rendering pass came from: an `intent` is a one-sentence LABEL by contract,
  // so scoring a long transcript's length against it flagged ordinary dictation as "disproportionate"
  // and replaced the user's own 600 characters with the 50-character label.
  it("never degrades long ordinary speech just because the model's intent label is short", () => {
    const transcript =
      "I have this weird bug right now where if I have the canvases in stage mode, if I flip back and " +
      "forth between canvases, then the terminal UI on the terminal that is up in stage mode when I " +
      "switch to the canvas will be completely blank, it doesn't render, until I flip back and forth " +
      "between different terminals or from stage to grid mode then it will load. I think it's some sort " +
      "of issue where when I flip from canvas to canvas while stage mode is enabled, that first terminal " +
      "that is being shown does not render properly. Can you go surgical with this and find the root of it.";
    const compilation = compileAgentDelegation({
      target: "Marshall",
      transcript,
      language: "auto",
      intent: "Investigate the blank terminal UI bug in stage mode.",
    });

    expect(compilation.packet.transcriptIntegrity.reasons).not.toContain("disproportionate");
    expect(compilation.packet.transcriptQuality).toBe("clean");
    expect(compilation.mode).toBe("direct");
    expect(compilation.workerMessage).toBe(transcript);
  });

  it("still catches accumulator duplication, which is a repetition shape and needs no length baseline", () => {
    const compilation = compileAgentDelegation({
      target: "Nova",
      transcript: CORRUPTED_ACCUMULATOR_SAMPLE,
      language: "id",
      intent: "Jelaskan project ini secara singkat",
    });

    expect(compilation.packet.transcriptIntegrity.reasons).toContain("repetition");
    expect(compilation.packet.transcriptQuality).toBe("degraded");
  });

  it("emits no markdown scaffolding in any mode — an agent chat is not a form", () => {
    const cases = [
      compileAgentDelegation({ target: "A", transcript: "Fix the login bug.", language: "en" }),
      compileAgentDelegation({ target: "A", transcript: "Fix the login bug and", language: "en" }),
      compileAgentDelegation({ target: "A", transcript: "", language: "en", intent: "Fix it.", transcriptPending: true }),
      compileAgentDelegation({ target: "A", transcript: CORRUPTED_ACCUMULATOR_SAMPLE, language: "id", intent: "Jelaskan." }),
      compileAgentDelegation({ target: "A", transcript: CORRUPTED_ACCUMULATOR_SAMPLE, language: "id" }),
    ];

    for (const compilation of cases) {
      expect(compilation.workerMessage).not.toContain("# Delegated voice task");
      expect(compilation.workerMessage).not.toMatch(/^#{1,6}\s/m);
      expect(compilation.workerMessage).not.toMatch(/^-\s/m);
      expect(compilation.workerMessage).not.toContain("Objective:");
    }
  });
});

describe("hasSuspectTranscriptTail", () => {
  it("is true for a trailing ellipsis (ASCII or unicode)", () => {
    expect(hasSuspectTranscriptTail("Refactor the auth module...")).toBe(true);
    expect(hasSuspectTranscriptTail("Refactor the auth module…")).toBe(true);
  });

  it("is true for a dangling conjunction/preposition in Indonesian or English", () => {
    expect(hasSuspectTranscriptTail("Cek file ini dan")).toBe(true);
    expect(hasSuspectTranscriptTail("Review the auth module and")).toBe(true);
  });

  it("is false for a clean, complete sentence", () => {
    expect(hasSuspectTranscriptTail("Fix the login bug and add a regression test.")).toBe(false);
  });
});
