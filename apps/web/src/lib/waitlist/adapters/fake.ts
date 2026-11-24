/**
 * Test adapter. Records what it was asked to describe so tests can assert the
 * seam was crossed with the right arguments, without reaching a network or a DOM.
 *
 * Its existence is what makes the seam real rather than hypothetical: two shipping
 * adapters plus this one.
 */
import type { SubmitMode, WaitlistAdapter, SubmissionPlan } from "../types";

export interface FakeAdapter extends WaitlistAdapter {
  readonly calls: readonly { email: string; tag: string }[];
}

export function createFakeAdapter(mode: SubmitMode = "inline"): FakeAdapter {
  const calls: { email: string; tag: string }[] = [];
  return {
    mode,
    calls,
    describe(input): SubmissionPlan {
      calls.push({ ...input });
      return {
        mode,
        action: "https://example.test/subscribe",
        method: "post",
        hidden: [{ name: "tag", value: input.tag }],
      };
    },
  };
}
