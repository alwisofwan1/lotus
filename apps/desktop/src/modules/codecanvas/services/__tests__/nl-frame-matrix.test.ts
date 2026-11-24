import { describe, expect, it } from "vitest";
import { matchLocalIntent } from "../canvas-nl-fastpath";
import { parseNlIntents } from "../canvas-nl-parse";
import frames from "./__fixtures__/nl-frames.json";

/**
 * Frame-accuracy regression matrix (plan §Slice 8). Each fixture pins an utterance (or a canned model
 * reply) to the EXACT intent frame the pipeline must produce — the standing net that keeps the bug
 * classes fixed in Slices 1–7 from regressing. "Close semua browser." is case #1.
 *
 * Two deterministic paths, no live model:
 *   • "fastpath" — matchLocalIntent(utterance) must equal the frame (or null when it should bail to LLM).
 *   • "parse"    — parseNlIntents(reply) must equal the frame (the model-emitted-JSON → typed-intent contract).
 * LLM-path *generation* accuracy (does haiku emit the right JSON?) is a separate live eval, out of CI scope.
 */

const DEFAULT_KINDS = ["terminal", "note", "plan", "task", "context", "critic", "human-gate", "team", "music"] as const;

interface FastpathFrame {
  name: string;
  kind: "fastpath";
  utterance: string;
  expected: unknown;
  nodeKinds?: string[];
  agentNames?: string[];
}
interface ParseFrame {
  name: string;
  kind: "parse";
  reply: string;
  expected: unknown;
}
type Frame = FastpathFrame | ParseFrame;

const fixtures = frames as Frame[];

describe("NL frame-accuracy matrix", () => {
  it("covers a meaningful spread of cases (guards against silent fixture loss)", () => {
    // If this count ever drops, a fixture was deleted rather than fixed — surface it loudly.
    expect(fixtures.length).toBeGreaterThanOrEqual(25);
    const fastpath = fixtures.filter((f) => f.kind === "fastpath").length;
    const parse = fixtures.filter((f) => f.kind === "parse").length;
    console.info(`[nl-frame-matrix] ${fixtures.length} frames (${fastpath} fast-path, ${parse} parse)`);
    expect(fastpath).toBeGreaterThan(0);
    expect(parse).toBeGreaterThan(0);
  });

  for (const f of fixtures) {
    it(`${f.kind}: ${f.name}`, () => {
      if (f.kind === "fastpath") {
        const ctx = {
          nodeKinds: (f.nodeKinds ?? DEFAULT_KINDS) as readonly string[] as never,
          ...(f.agentNames ? { agentNames: f.agentNames } : {}),
        };
        expect(matchLocalIntent(f.utterance, ctx)).toEqual(f.expected);
      } else {
        expect(parseNlIntents(f.reply)).toEqual(f.expected);
      }
    });
  }
});
