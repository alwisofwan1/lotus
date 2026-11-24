import { describe, expect, it } from "vitest";
import { composeAgentRef, parseAgentRef, setFlag } from "../agent-ref";

describe("agent ref", () => {
  it("round-trips a preset with a choice on top", () => {
    const ref = "preset_1?model=opus&effort=high&account=acme";
    expect(parseAgentRef(ref)).toEqual({ presetId: "preset_1", model: "opus", effort: "high", account: "acme" });
    expect(composeAgentRef(parseAgentRef(ref))).toBe(ref);
  });

  it("replaces a flag in either form", () => {
    expect(setFlag("--model sonnet -v", "--model", "opus")).toBe("-v --model opus");
    expect(setFlag("--effort=low", "--effort", "high")).toBe("--effort high");
  });

  it("keeps a plain preset id as it is", () => {
    expect(parseAgentRef("preset_1")).toEqual({ presetId: "preset_1" });
    expect(composeAgentRef({ presetId: "preset_1", model: undefined })).toBe("preset_1");
  });
});
