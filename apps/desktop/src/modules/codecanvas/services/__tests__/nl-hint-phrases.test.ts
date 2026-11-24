import { describe, expect, it } from "vitest";
import {
  buildNlHintPhrases,
  NL_HINT_MAX_PHRASE_LENGTH,
  NL_HINT_MAX_PHRASES,
  NL_HINT_SELECTION_PHRASES,
  type NlHintContext,
} from "../nl-hint-phrases";
import { matchLocalIntent } from "../canvas-nl-fastpath";
import { CANVAS_CREATE_NODE_KINDS } from "../commands/canvas-command";

function ctx(overrides: Partial<NlHintContext> = {}): NlHintContext {
  return {
    agentNames: [],
    nodeCount: 0,
    hasNoteSelection: false,
    otherProjectNames: [],
    ...overrides,
  };
}

function fastPath(phrase: string, agentNames: readonly string[] = []) {
  return matchLocalIntent(phrase, { nodeKinds: CANVAS_CREATE_NODE_KINDS, agentNames });
}

/**
 * The plan's hard invariant: every phrase must be carried by a route that really exists, so the bar
 * never advertises a capability it doesn't have. Checked against the REAL routing code, not a fixture
 * list — and route-aware, because the bar's two local routes have OPPOSITE requirements:
 *
 *   - command-route phrases MUST match `matchLocalIntent` (they run locally, zero model tokens);
 *   - selection-route phrases MUST NOT, because `resolveVoiceOutcome` gates the transform outcome on
 *     `!hasCommandVerb(text)` — a fast-path hit wins and would steal the utterance from `runTransform`.
 *
 * So a selection phrase that started matching the fast path would silently stop rewriting the
 * selection. That is a real regression this assertion is here to catch, not a loophole.
 */
function expectEveryPhraseRoutable(phrases: string[], agentNames: readonly string[] = []) {
  for (const phrase of phrases) {
    if (NL_HINT_SELECTION_PHRASES.includes(phrase)) {
      expect(
        fastPath(phrase, agentNames),
        `selection-route phrase "${phrase}" must NOT match the fast path, or the transform outcome is unreachable`,
      ).toBeNull();
    } else {
      expect(
        fastPath(phrase, agentNames),
        `expected the fast-path parser to match hint phrase: "${phrase}"`,
      ).not.toBeNull();
    }
  }
}

describe("buildNlHintPhrases", () => {
  it("shows onboarding phrases on an empty board", () => {
    const phrases = buildNlHintPhrases(ctx({ nodeCount: 0 }));
    expect(phrases).toEqual(["spawn a Claude agent", "create a terminal", "open a browser"]);
    expectEveryPhraseRoutable(phrases);
  });

  it("teaches focus / dispatch / arrange once agents are on the board", () => {
    const phrases = buildNlHintPhrases(ctx({ nodeCount: 2, agentNames: ["Skye", "Rex"] }));
    expect(phrases).toEqual(["focus Skye", "tell Rex to run the tests", "arrange the canvas"]);
    expectEveryPhraseRoutable(phrases, ["Skye", "Rex"]);
  });

  it("borrows the same agent for both roles when only one agent exists", () => {
    const phrases = buildNlHintPhrases(ctx({ nodeCount: 1, agentNames: ["Skye"] }));
    expect(phrases).toEqual(["focus Skye", "tell Skye to run the tests", "arrange the canvas"]);
    expectEveryPhraseRoutable(phrases, ["Skye"]);
  });

  it("adds a switch-project phrase per other open project, capped at two", () => {
    const phrases = buildNlHintPhrases(
      ctx({ otherProjectNames: ["orbit-vault", "swarm-command-center", "codecanvas-labs"] }),
    );
    expect(phrases).toContain("switch to project orbit-vault");
    expect(phrases).toContain("switch to project swarm-command-center");
    expect(phrases).not.toContain("switch to project codecanvas-labs");
    expectEveryPhraseRoutable(phrases);
  });

  it("never emits a status-query phrase — it has no verified route, fast-path or otherwise", () => {
    const phrases = buildNlHintPhrases(ctx({ nodeCount: 1, agentNames: ["Rex"] }));
    expect(phrases.some((p) => /doing/i.test(p))).toBe(false);
    expectEveryPhraseRoutable(phrases, ["Rex"]);
  });

  it("offers the selection phrases only while a note selection exists", () => {
    const withSelection = buildNlHintPhrases(ctx({ nodeCount: 1, agentNames: ["Rex"], hasNoteSelection: true }));
    expect(withSelection).toContain("rewrite this shorter");
    expectEveryPhraseRoutable(withSelection, ["Rex"]);

    // Nothing selected — suggesting a rewrite would advertise an outcome the router cannot reach.
    const withoutSelection = buildNlHintPhrases(ctx({ nodeCount: 1, agentNames: ["Rex"] }));
    expect(withoutSelection.some((p) => /rewrite/i.test(p))).toBe(false);
  });

  it("keeps the selection phrases OUT of the fast path — the transform route depends on them missing", () => {
    // Pins the inverted half of the invariant directly against the matcher: if a future fast-path
    // intent starts claiming these strings, resolveVoiceOutcome's `!hasCommandVerb` gate diverts them
    // and the selection silently stops being rewritten.
    for (const phrase of NL_HINT_SELECTION_PHRASES) expect(fastPath(phrase)).toBeNull();
  });

  it("drops an over-length phrase rather than let it overflow the bar", () => {
    const longName = "A".repeat(60);
    const phrases = buildNlHintPhrases(ctx({ nodeCount: 1, agentNames: [longName] }));
    expect(phrases.every((p) => p.length <= NL_HINT_MAX_PHRASE_LENGTH)).toBe(true);
    expect(phrases).not.toContain(`focus ${longName}`);
    // the phrase that doesn't depend on the long name still comes through
    expect(phrases).toContain("arrange the canvas");
  });

  it("never returns more than the phrase cap, even with many agents and projects", () => {
    const phrases = buildNlHintPhrases(
      ctx({
        nodeCount: 3,
        agentNames: ["Skye", "Rex", "Nova", "Juno", "Cass"],
        otherProjectNames: ["alpha", "beta", "gamma", "delta"],
      }),
    );
    expect(phrases.length).toBeLessThanOrEqual(NL_HINT_MAX_PHRASES);
    expectEveryPhraseRoutable(phrases, ["Skye", "Rex", "Nova", "Juno", "Cass"]);
  });

  it("is deterministic — no randomness, same context always returns the same order", () => {
    const c = ctx({ nodeCount: 2, agentNames: ["Skye", "Rex"], otherProjectNames: ["orbit-vault"] });
    expect(buildNlHintPhrases(c)).toEqual(buildNlHintPhrases(c));
  });

  it("drops the plan's own 'switch to <Project>' shorthand in favor of a form the fast-path matches", () => {
    // Regression pin for the invariant check performed while building the phrase list: the fast-path
    // switch_project regex requires an explicit project/canvas/workspace noun before the name, so the
    // plan table's bare "switch to orbit-vault" phrasing fails the invariant and must never ship.
    const bareCtx = { nodeKinds: CANVAS_CREATE_NODE_KINDS, agentNames: [] };
    expect(matchLocalIntent("switch to orbit-vault", bareCtx)).toBeNull();
    expect(matchLocalIntent("switch to project orbit-vault", bareCtx)).not.toBeNull();
  });

  it("never hands the rotator an empty list on a board with nodes but no agents", () => {
    // The regression this guards: gating onboarding on `nodeCount === 0` alone left the single most
    // ordinary board — a lone terminal or note, one project open, no agents yet — with NOTHING to
    // say, so the bar rendered a blank prompt. That is strictly worse than the constant string this
    // feature replaced. Every phrase-less combination must still fall back to something teachable.
    for (const nodeCount of [1, 3, 12]) {
      const phrases = buildNlHintPhrases(ctx({ nodeCount }));
      expect(phrases.length, `nodeCount ${nodeCount} produced no phrases`).toBeGreaterThan(0);
      expectEveryPhraseRoutable(phrases);
    }
  });

  it("still teaches something on an empty, agent-less, project-less board", () => {
    // nodeCount 0 with no agents/projects still gets onboarding — verifies onboarding isn't
    // accidentally gated on anything else.
    const phrases = buildNlHintPhrases(ctx());
    expect(phrases.length).toBeGreaterThan(0);
    expectEveryPhraseRoutable(phrases);
  });
});
