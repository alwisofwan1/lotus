import { describe, expect, it } from "vitest";
import { nextS2sVoiceContextVersion } from "../s2s-voice-context-version";
import type { S2sCanvasLiveVoiceContext } from "../s2s-canvas-live-context";

function ctx(agentTargetHints: string[]): S2sCanvasLiveVoiceContext {
  return { nodeRefs: [], roster: [], agentNames: [], agentTargetHints, nodeSummaries: agentTargetHints.map((name) => `${name} (agent)`), hasBrowserNodes: false };
}

describe("S2S voice context version", () => {
  it("increments only when the live voice context changes", () => {
    const v1 = nextS2sVoiceContextVersion(null, ctx(["Sena (Claude 1)"]));
    const same = nextS2sVoiceContextVersion(v1, ctx(["Sena (Claude 1)"]));
    const changed = nextS2sVoiceContextVersion(same, ctx(["Sena (Claude 1)", "Bima (Claude 2)"]));

    expect(v1.version).toBe(1);
    expect(same).toBe(v1);
    expect(changed.version).toBe(2);
  });
});
