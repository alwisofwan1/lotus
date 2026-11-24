import { describe, it, expect } from "vitest";
import { resolveGovernance, AGENT_EFFORTS, DEFAULT_GOVERNANCE } from "../agent-governance";

describe("resolveGovernance", () => {
  it("defaults to medium effort with full (skip) permissions", () => {
    expect(resolveGovernance()).toEqual({ effort: "medium", skipPermissions: true });
    expect(DEFAULT_GOVERNANCE).toEqual({ effort: "medium", permissionMode: "full" });
  });

  it("maps safe permission mode to NOT skipping permissions (read-only run)", () => {
    expect(resolveGovernance({ permissionMode: "safe" }).skipPermissions).toBe(false);
    expect(resolveGovernance({ permissionMode: "full" }).skipPermissions).toBe(true);
  });

  it("passes the chosen effort through", () => {
    expect(resolveGovernance({ effort: "high" }).effort).toBe("high");
  });

  it("exposes the effort options for the settings picker", () => {
    expect(AGENT_EFFORTS).toContain("medium");
    expect(AGENT_EFFORTS).toContain("high");
  });
});
