import { describe, expect, it } from "vitest";
import { buildVoiceToolTraceEntry, isVoiceToolTraceEnabled } from "../s2s-voice-tool-trace";

describe("s2s voice tool trace", () => {
  it("is dev-only by policy", () => {
    expect(isVoiceToolTraceEnabled(true)).toBe(true);
    expect(isVoiceToolTraceEnabled(false)).toBe(false);
  });

  it("shows heard target, resolved visible target, tool, preview, and speak", () => {
    const entry = buildVoiceToolTraceEntry(
      { callId: "call-1", name: "dispatch", args: { target: "claude-3", task: "review the logging utility" } },
      { ok: true, summary: "Dispatch to Bima", speak: "I sent that to Bima.", nodeId: "rf-internal-uid" },
      7,
    );

    expect(entry).toEqual({
      id: "call-1",
      tool: "dispatch",
      ok: true,
      heardTarget: "claude-3",
      resolvedTarget: "Bima",
      preview: "review the logging utility",
      speak: "I sent that to Bima.",
      contextVersion: 7,
    });
    expect(JSON.stringify(entry)).not.toContain("rf-internal-uid");
  });

  it("records compact failures without exposing raw internals", () => {
    const entry = buildVoiceToolTraceEntry(
      { callId: "call-2", name: "focus", args: { target: "ghost" } },
      { ok: false, error: "No agent named ghost", nodeId: "secret-node-id" },
    );

    expect(entry).toMatchObject({ tool: "focus", ok: false, heardTarget: "ghost", error: "No agent named ghost" });
    expect(JSON.stringify(entry)).not.toContain("secret-node-id");
  });
});
