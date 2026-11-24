import { describe, expect, it } from "vitest";
import { createAgentIdentityRegistry } from "../agent-identity-registry";

describe("agentIdentityRegistry", () => {
  it("records and reads back a pane's identity", () => {
    const reg = createAgentIdentityRegistry();
    reg.record("a1", { name: "Rowan", projectId: "projA" });
    expect(reg.get("a1")).toEqual({ name: "Rowan", projectId: "projA" });
  });

  it("survives across an unmount — identity stays until an explicit forget", () => {
    const reg = createAgentIdentityRegistry();
    reg.record("a1", { name: "Rowan", projectId: "projA" });
    // (an unmount does NOT call forget — that is the whole point)
    expect(reg.get("a1")).toBeDefined();
    reg.forget("a1");
    expect(reg.get("a1")).toBeUndefined();
  });

  it("updates in place on re-record (name/project change)", () => {
    const reg = createAgentIdentityRegistry();
    reg.record("a1", { name: "Rowan", projectId: "projA" });
    reg.record("a1", { name: "Rowan the Bold", projectId: "projA" });
    expect(reg.get("a1")?.name).toBe("Rowan the Bold");
  });

  it("returns undefined for an unknown pane", () => {
    const reg = createAgentIdentityRegistry();
    expect(reg.get("nope")).toBeUndefined();
  });
});
