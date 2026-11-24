import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAgentReplyRegistration } from "../useAgentReplyRegistration";
import { createAgentReplyRegistry } from "../../services/agent-reply-registry";

describe("useAgentReplyRegistration", () => {
  it("does not advertise terminal insertion for an agent without an insert adapter", () => {
    const registry = createAgentReplyRegistry();
    renderHook(() => useAgentReplyRegistration("agent-1", true, vi.fn(), registry));

    expect(registry.get("agent-1")?.insert).toBeUndefined();
  });
});
