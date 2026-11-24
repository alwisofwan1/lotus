import { describe, expect, it } from "vitest";
import {
  STREAMING_STT_HYPOTHESIS_GRACE_MS,
  STREAMING_STT_SETTLED_TAIL_GRACE_MS,
  resolveStreamingSttFinalizationGraceMs,
} from "../streaming-stt-finalization-policy";

describe("resolveStreamingSttFinalizationGraceMs", () => {
  it("uses a short tail grace when the provider already committed text with no partial hypothesis", () => {
    expect(resolveStreamingSttFinalizationGraceMs({ committed: "open terminal", interim: "" }))
      .toBe(STREAMING_STT_SETTLED_TAIL_GRACE_MS);
    expect(STREAMING_STT_SETTLED_TAIL_GRACE_MS).toBeLessThan(900);
  });

  it("keeps the full correction window for an active hypothesis or no transcript yet", () => {
    expect(resolveStreamingSttFinalizationGraceMs({ committed: "", interim: "open term" }))
      .toBe(STREAMING_STT_HYPOTHESIS_GRACE_MS);
    expect(resolveStreamingSttFinalizationGraceMs({ committed: "", interim: "" }))
      .toBe(STREAMING_STT_HYPOTHESIS_GRACE_MS);
  });
});
