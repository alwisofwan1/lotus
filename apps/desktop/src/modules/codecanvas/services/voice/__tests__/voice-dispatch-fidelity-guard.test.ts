import { describe, it, expect } from "vitest";
import {
  extractCriticalTokens,
  findDroppedCriticalTokens,
  judgeVoiceComposition,
} from "../voice-dispatch-fidelity-guard";

describe("extractCriticalTokens", () => {
  it("pulls the spans whose loss would change what the agent does", () => {
    const tokens = extractCriticalTokens(
      "restart the server on port 3000, then patch src/modules/voice/auth.ts and bump react to 19.2.1 with --verbose",
    );
    expect(tokens).toContain("3000");
    expect(tokens).toContain("src/modules/voice/auth.ts");
    expect(tokens).toContain("19.2.1");
    expect(tokens).toContain("--verbose");
  });

  it("keeps backticked identifiers without their decoration", () => {
    expect(extractCriticalTokens("call `resolveTarget` first")).toContain("resolveTarget");
  });

  it("ignores single digits — a spoken list ordinal is legitimately rewritten as a word", () => {
    expect(extractCriticalTokens("first do 1 thing then the other")).toEqual([]);
  });

  it("dedupes repeated mentions and returns nothing for plain prose", () => {
    expect(extractCriticalTokens("bump to 19.2.1 and then verify 19.2.1")).toEqual(["19.2.1"]);
    expect(extractCriticalTokens("please review the login flow and report back")).toEqual([]);
  });
});

describe("findDroppedCriticalTokens", () => {
  it("reports a concrete fact the rewrite lost", () => {
    expect(
      findDroppedCriticalTokens("restart the server on port 3000", "restart the server"),
    ).toEqual(["3000"]);
  });

  it("accepts a rewrite that kept the fact, even re-decorated as code", () => {
    expect(findDroppedCriticalTokens("patch auth.ts please", "Patch `auth.ts`.")).toEqual([]);
  });
});

describe("judgeVoiceComposition", () => {
  const spoken =
    "okay so I want you to run the whole test suite on port 3000 and then tell me which files are failing please";

  it("accepts a faithful cleanup", () => {
    const verdict = judgeVoiceComposition(
      spoken,
      "Run the whole test suite on port 3000, then tell me which files are failing.",
    );
    expect(verdict.ok).toBe(true);
  });

  it("rejects a composition that dropped a concrete detail even at a plausible length", () => {
    const verdict = judgeVoiceComposition(
      spoken,
      "Run the whole test suite and then tell me exactly which of the files are failing.",
    );
    expect(verdict).toMatchObject({ ok: false, failure: "detail-loss", dropped: ["3000"] });
  });

  it("rejects a composition that dropped the user's prohibition", () => {
    const verdict = judgeVoiceComposition(
      "have a look at the auth flow but don't change any of the code while you are in there",
      "Review the auth flow and clean up the code while you are in there.",
    );
    expect(verdict).toMatchObject({ ok: false, failure: "negation-loss" });
  });

  it("rejects same-length semantic drift even when no path, number, or negation was lost", () => {
    const verdict = judgeVoiceComposition(
      "please inspect the authentication flow and explain why the current login session sometimes expires unexpectedly after a refresh",
      "redesign the payment checkout and implement a new database migration with complete monitoring before the next release ships",
    );

    expect(verdict).toMatchObject({ ok: false, failure: "semantic-drift" });
  });

  it("accepts a prohibition that was merely rephrased", () => {
    const verdict = judgeVoiceComposition(
      "have a look at the auth flow but don't change any of the code while you are in there",
      "Review the auth flow, but do not change any of the code while you are in there.",
    );
    expect(verdict.ok).toBe(true);
  });

  // No critical token in this one, so the length band is the only thing that can catch it — which is
  // exactly the case the ratio exists for.
  it("rejects a summary of speech that carried no concrete token to check", () => {
    const chatty =
      "okay so I want you to go through the whole login flow and then tell me which parts of it feel " +
      "fragile to you and why, and be honest about it please";
    expect(judgeVoiceComposition(chatty, "Review the login flow.")).toMatchObject({
      ok: false,
      failure: "summary",
    });
  });

  it("rejects an expansion — the model started planning instead of rewriting", () => {
    const invented =
      "Run the whole test suite on port 3000 and report which files fail. Acceptance criteria: " +
      "every suite passes, coverage stays above eighty percent, the report lists each failing file " +
      "with its stack trace, and a follow-up ticket is opened for anything that cannot be fixed " +
      "immediately. Start by installing dependencies and warming the cache before the run begins.";
    expect(judgeVoiceComposition(spoken, invented)).toMatchObject({ ok: false, failure: "expansion" });
  });

  it("leaves the length band out of the way for short speech, but still guards the facts", () => {
    expect(judgeVoiceComposition("deploy it", "Deploy it now").ok).toBe(true);
    expect(judgeVoiceComposition("use port 8080", "Use the usual port")).toMatchObject({
      ok: false,
      failure: "detail-loss",
    });
  });
});
